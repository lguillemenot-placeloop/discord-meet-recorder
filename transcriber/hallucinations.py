"""Phrases que Whisper invente sur du silence ou du bruit.

Whisper a appris sur des vidéos sous-titrées : face à un passage sans parole, il « complète » souvent
avec une fin de vidéo YouTube ou un crédit de sous-titrage. Le filtre de silence de faster-whisper
(no_speech_threshold / log_prob_threshold) ne les attrape pas toutes, car Whisper les produit avec
assurance. On les retire donc d'après leur texte.

La liste ne vise que des tournures qui n'ont rien à faire dans une réunion de travail : un « Merci. »
ou un « OK. » isolé est presque toujours une vraie intervention et reste.
"""

from __future__ import annotations

import re

_PATTERNS = [
    # Fins de vidéo
    r"merci d'avoir regard[ée]",
    r"merci (à tous )?d'avoir (suivi|écouté) cette vid[ée]o",
    r"(j'esp[èe]re que |si )vous avez (apprécié|aimé) cette vid[ée]o",
    r"à (la prochaine|bientôt|très vite) pour (une|un) (nouvelle|nouveau) vid[ée]o",
    r"abonne[zr]?[- ](vous|toi)",
    r"vous abonner",
    r"(laissez|mettez) un (like|pouce|commentaire)",
    r"activez? la (cloche|clochette)",
    r"(notre|ma|la) cha[îi]ne youtube",
    # Crédits de sous-titrage
    r"sous-titr",
    r"\bst ?'? ?501\b",
    r"amara\.org",
    r"soustitreur",
    # Équivalents anglais, Whisper bascule parfois de langue sur du silence
    r"thanks? (you )?for watching",
    r"please subscribe",
    r"subscribe to (my|our|the) channel",
    r"subtitles by",
]
_REGEX = re.compile("|".join(f"(?:{p})" for p in _PATTERNS), re.IGNORECASE)


def normalize(text: str) -> str:
    return text.replace("’", "'").replace("ʼ", "'").lower()


def is_hallucination(text: str) -> bool:
    return bool(_REGEX.search(normalize(text)))
