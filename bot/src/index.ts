import {
  entersState,
  joinVoiceChannel,
  VoiceConnectionStatus,
  type VoiceConnection,
} from '@discordjs/voice';
import {
  ChannelType,
  ChatInputCommandInteraction,
  Client,
  Events,
  GatewayIntentBits,
  GuildMember,
  MessageFlags,
  SlashCommandBuilder,
  type Guild,
  type VoiceBasedChannel,
} from 'discord.js';
import { MeetingRecorder } from './recorder.js';
import { meetingId, MeetingStore, type Meeting } from './store.js';

const TOKEN = requiredEnv('DISCORD_TOKEN');
const DATA_DIR = process.env.DATA_DIR ?? '/data';
/** Le bot quitte le salon s'il y reste seul pendant ce temps. */
const AUTO_STOP_EMPTY_MS = Number(process.env.AUTO_STOP_EMPTY_SECONDS ?? 60) * 1000;
/** Garde-fou : un meet oublié s'arrête tout seul. */
const MAX_MEETING_MS = Number(process.env.MAX_MEETING_MINUTES ?? 180) * 60_000;
/** Phrase qui arrête le meet à la voix (détectée par le transcripteur). Vide : désactivé. */
const STOP_PHRASE = (process.env.STOP_PHRASE ?? '').trim();

const store = new MeetingStore(DATA_DIR);

interface ActiveMeeting {
  meeting: Meeting;
  connection: VoiceConnection;
  recorder: MeetingRecorder;
  emptyTimer: NodeJS.Timeout | null;
  maxTimer: NodeJS.Timeout;
}

/** Un seul meet à la fois par serveur Discord. */
const active = new Map<string, ActiveMeeting>();

const command = new SlashCommandBuilder()
  .setName('meet')
  .setDescription('Enregistrer et transcrire le salon vocal')
  .addSubcommand((sub) =>
    sub
      .setName('start')
      .setDescription('Rejoindre ton salon vocal et commencer à transcrire')
      .addStringOption((opt) => opt.setName('titre').setDescription('Sujet du meet').setMaxLength(100)),
  )
  .addSubcommand((sub) => sub.setName('stop').setDescription('Arrêter l’enregistrement et lancer la transcription'))
  .addSubcommand((sub) => sub.setName('status').setDescription('Voir si un meet est en cours'));

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });

client.once(Events.ClientReady, async (c) => {
  console.log(`[bot] connecté en tant que ${c.user.tag}`);
  await recoverInterruptedMeetings();
  for (const guild of c.guilds.cache.values()) await registerCommands(guild);
  setInterval(() => notifyFinishedTranscriptions().catch((e) => console.error('[notify]', e)), 15_000);
  if (STOP_PHRASE) setInterval(() => void checkVoiceStops(), 1_000);
});

let checkingVoiceStops = false;

/** Arrête les meets pour lesquels le transcripteur a entendu la phrase d'arrêt. */
async function checkVoiceStops(): Promise<void> {
  if (checkingVoiceStops) return;
  checkingVoiceStops = true;
  try {
    for (const [guildId, current] of [...active]) {
      const request = await store.stopRequest(current.meeting.id);
      if (request && active.get(guildId) === current) {
        await finishMeeting(guildId, `${request.speaker} a dit « ${request.text} »`);
      }
    }
  } catch (err) {
    console.error('[bot] arrêt à la voix :', err);
  } finally {
    checkingVoiceStops = false;
  }
}

client.on(Events.GuildCreate, (guild) => void registerCommands(guild));

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand() || interaction.commandName !== 'meet' || !interaction.inCachedGuild()) return;
  try {
    const sub = interaction.options.getSubcommand();
    if (sub === 'start') await handleStart(interaction);
    else if (sub === 'stop') await handleStop(interaction);
    else await handleStatus(interaction);
  } catch (err) {
    console.error('[bot] commande /meet :', err);
    const content = `Erreur : ${(err as Error).message}`;
    if (interaction.deferred || interaction.replied) await interaction.editReply(content).catch(() => {});
    else await interaction.reply({ content, flags: MessageFlags.Ephemeral }).catch(() => {});
  }
});

client.on(Events.VoiceStateUpdate, (oldState, newState) => {
  const current = active.get(newState.guild.id);
  if (!current) return;
  const channelId = current.meeting.channelId;
  if (oldState.channelId !== channelId && newState.channelId !== channelId) return;

  // Le bot a été sorti du salon (déconnecté, déplacé) : on clôt proprement.
  if (newState.id === client.user?.id && newState.channelId !== channelId) {
    void finishMeeting(newState.guild.id, 'le bot a été retiré du salon');
    return;
  }

  const channel = newState.guild.channels.cache.get(channelId);
  const humans = channel?.isVoiceBased() ? channel.members.filter((m) => !m.user.bot).size : 0;
  if (humans === 0 && !current.emptyTimer) {
    current.emptyTimer = setTimeout(() => void finishMeeting(newState.guild.id, 'salon vide'), AUTO_STOP_EMPTY_MS);
  } else if (humans > 0 && current.emptyTimer) {
    clearTimeout(current.emptyTimer);
    current.emptyTimer = null;
  }
});

async function handleStart(interaction: ChatInputCommandInteraction<'cached'>): Promise<void> {
  const member = interaction.member as GuildMember;
  const voice = member.voice.channel;
  if (!voice) {
    await interaction.reply({ content: 'Rejoins d’abord un salon vocal.', flags: MessageFlags.Ephemeral });
    return;
  }
  if (active.has(interaction.guildId)) {
    const m = active.get(interaction.guildId)!.meeting;
    await interaction.reply({
      content: `Un meet est déjà enregistré dans <#${m.channelId}>. \`/meet stop\` pour l’arrêter.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  await interaction.deferReply();

  const startedAt = new Date();
  const meeting: Meeting = {
    id: meetingId(startedAt, voice.name),
    title: interaction.options.getString('titre') ?? `Meet ${voice.name}`,
    guildId: interaction.guildId,
    guildName: interaction.guild.name,
    channelId: voice.id,
    channelName: voice.name,
    textChannelId: interaction.channelId,
    startedBy: { id: member.id, name: member.displayName },
    startedAt: startedAt.toISOString(),
    endedAt: null,
    status: 'recording',
    participants: {},
  };

  const connection = await connect(voice);
  try {
    await store.create(meeting);
  } catch (err) {
    // Sans ça, le bot resterait dans le salon vocal sans rien enregistrer.
    connection.destroy();
    throw err;
  }
  const recorder = new MeetingRecorder(connection, meeting, store, (userId) => speakerName(interaction.guild, userId));
  recorder.start();

  connection.on(VoiceConnectionStatus.Disconnected, async () => {
    try {
      // Changement de salon ou de région : Discord reconnecte tout seul.
      await Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
        entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
      ]);
    } catch {
      await finishMeeting(meeting.guildId, 'connexion vocale perdue');
    }
  });

  active.set(meeting.guildId, {
    meeting,
    connection,
    recorder,
    emptyTimer: null,
    maxTimer: setTimeout(() => void finishMeeting(meeting.guildId, 'durée maximale atteinte'), MAX_MEETING_MS),
  });

  console.log(`[bot] meet ${meeting.id} démarré dans #${voice.name}`);
  await interaction.editReply(
    `🔴 **Enregistrement en cours** dans <#${voice.id}> : tout ce qui est dit sera transcrit ` +
      `(démarré par ${member.displayName}). \`/meet stop\` pour arrêter` +
      (STOP_PHRASE ? `, ou dites « ${STOP_PHRASE} »` : '') +
      `.\n-# Meet \`${meeting.id}\``,
  );
}

async function handleStop(interaction: ChatInputCommandInteraction<'cached'>): Promise<void> {
  if (!active.has(interaction.guildId)) {
    await interaction.reply({ content: 'Aucun meet en cours.', flags: MessageFlags.Ephemeral });
    return;
  }
  await interaction.deferReply();
  const meeting = await finishMeeting(interaction.guildId, `arrêté par ${interaction.member.displayName}`, false);
  await interaction.editReply(stoppedMessage(meeting));
}

async function handleStatus(interaction: ChatInputCommandInteraction<'cached'>): Promise<void> {
  const current = active.get(interaction.guildId);
  const content = current
    ? `🔴 Meet \`${current.meeting.id}\` en cours dans <#${current.meeting.channelId}> depuis ` +
      `<t:${Math.floor(Date.parse(current.meeting.startedAt) / 1000)}:R> (${current.recorder.segments} prises de parole).`
    : 'Aucun meet en cours.';
  await interaction.reply({ content, flags: MessageFlags.Ephemeral });
}

async function connect(channel: VoiceBasedChannel): Promise<VoiceConnection> {
  const connection = joinVoiceChannel({
    channelId: channel.id,
    guildId: channel.guild.id,
    adapterCreator: channel.guild.voiceAdapterCreator,
    selfDeaf: false, // indispensable pour recevoir l'audio
    selfMute: true,
  });
  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
    return connection;
  } catch (err) {
    connection.destroy();
    throw new Error('impossible de rejoindre le salon vocal (permissions « Se connecter » du bot ?)', { cause: err });
  }
}

/**
 * Clôt le meet : écrit les dernières prises de parole, quitte le salon et passe le meet
 * en « recorded » pour que le transcripteur le prenne.
 */
async function finishMeeting(guildId: string, reason: string, announce = true): Promise<Meeting> {
  const current = active.get(guildId);
  if (!current) throw new Error('aucun meet en cours');
  active.delete(guildId);
  if (current.emptyTimer) clearTimeout(current.emptyTimer);
  clearTimeout(current.maxTimer);

  await current.recorder.stop();
  current.connection.destroy();

  const { meeting } = current;
  meeting.endedAt = new Date().toISOString();
  meeting.status = current.recorder.segments > 0 ? 'recorded' : 'failed';
  if (meeting.status === 'failed') meeting.error = 'aucune prise de parole enregistrée';
  await store.save(meeting);
  console.log(`[bot] meet ${meeting.id} terminé (${reason}), ${current.recorder.segments} prises de parole`);

  if (announce) await sendToTextChannel(meeting, `${stoppedMessage(meeting)}\n-# Raison : ${reason}.`);
  return meeting;
}

function stoppedMessage(meeting: Meeting): string {
  if (meeting.status === 'failed') return `⏹️ Meet arrêté, mais personne n’a parlé : rien à transcrire.`;
  return `⏹️ **Enregistrement arrêté.** Transcription en cours, je préviens ici quand elle est prête.\n-# Meet \`${meeting.id}\``;
}

const nameCache = new Map<string, string | null>();

async function speakerName(guild: Guild, userId: string): Promise<string | null> {
  const key = `${guild.id}:${userId}`;
  if (nameCache.has(key)) return nameCache.get(key)!;
  const member = await guild.members.fetch(userId).catch(() => null);
  const name = member ? (member.user.bot ? null : member.displayName) : userId;
  nameCache.set(key, name);
  return name;
}

async function registerCommands(guild: Guild): Promise<void> {
  try {
    await guild.commands.set([command.toJSON()]);
    console.log(`[bot] commande /meet enregistrée sur « ${guild.name} »`);
  } catch (err) {
    console.error(`[bot] enregistrement de /meet sur « ${guild.name} » :`, err);
  }
}

async function sendToTextChannel(meeting: Meeting, content: string): Promise<void> {
  if (!meeting.textChannelId) return;
  const channel = await client.channels.fetch(meeting.textChannelId).catch(() => null);
  if (channel && (channel.type === ChannelType.GuildText || channel.isVoiceBased()) && channel.isSendable()) {
    await channel.send(content).catch((e) => console.error('[bot] envoi du message :', e));
  }
}

/** Annonce dans Discord les transcriptions que le transcripteur a terminées. */
async function notifyFinishedTranscriptions(): Promise<void> {
  for (const meeting of await store.list()) {
    if (meeting.status !== 'transcribed' && !(meeting.status === 'failed' && meeting.endedAt)) continue;
    if (await store.isNotified(meeting.id)) continue;
    await store.markNotified(meeting.id);
    if (meeting.status === 'failed' && meeting.error === 'aucune prise de parole enregistrée') continue;
    const content =
      meeting.status === 'transcribed'
        ? `📝 **Transcription prête** : « ${meeting.title} » (${Object.values(meeting.participants).join(', ')}).\n` +
          `Dans Claude : « résume le meet Discord \`${meeting.id}\` ».`
        : `⚠️ La transcription du meet \`${meeting.id}\` a échoué : ${meeting.error ?? 'erreur inconnue'}.`;
    await sendToTextChannel(meeting, content);
  }
}

/** Après un crash ou un redémarrage, un meet resté « recording » est transcrit avec ce qui a été écrit. */
async function recoverInterruptedMeetings(): Promise<void> {
  for (const meeting of await store.list()) {
    if (meeting.status !== 'recording') continue;
    meeting.status = 'recorded';
    meeting.endedAt = new Date().toISOString();
    meeting.error = 'meet interrompu par un redémarrage du bot';
    await store.save(meeting);
    console.warn(`[bot] meet ${meeting.id} interrompu, envoyé en transcription tel quel`);
  }
}

async function shutdown(): Promise<void> {
  console.log('[bot] arrêt : clôture des meets en cours');
  await Promise.allSettled([...active.keys()].map((g) => finishMeeting(g, 'redémarrage du bot')));
  await client.destroy();
  process.exit(0);
}
process.once('SIGTERM', () => void shutdown());
process.once('SIGINT', () => void shutdown());

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Variable d'environnement manquante : ${name}`);
    process.exit(1);
  }
  return value;
}

await client.login(TOKEN);
