# Optional: run with Docker instead of a virtualenv (same image on Mac and Linux).
FROM python:3.11-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app ./app
COPY run.py config.example.yaml ./
EXPOSE 8000
CMD ["python", "run.py"]
