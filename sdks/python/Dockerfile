# Minimal Dockerfile for ASMP Python SDK (for docker-compose)
FROM python:3.11-slim
WORKDIR /app
COPY sdks/python/ /app/
COPY spec/ /app/spec/
COPY skills/ /app/skills/
RUN pip install -e . uvicorn
ENV PYTHONPATH=/app
EXPOSE 8000
CMD ["python", "-m", "uvicorn", "run:app", "--host", "0.0.0.0", "--port", "8000"]
