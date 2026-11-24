FROM python:3.12-slim

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY transcriber.py stop_phrase.py hallucinations.py ./

# Même uid que l'utilisateur « node » du bot : les deux écrivent dans le volume /data.
# Les volumes nommés reprennent ce propriétaire à leur création.
RUN useradd --uid 1000 --create-home app && mkdir /data /models && chown app:app /data /models
USER app

# Les modèles Whisper téléchargés sont gardés dans un volume pour ne pas les retélécharger.
ENV HF_HOME=/models PYTHONUNBUFFERED=1
CMD ["python", "transcriber.py"]
