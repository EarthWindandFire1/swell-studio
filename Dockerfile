FROM node:22-bookworm-slim AS ui
WORKDIR /ui
COPY frontend/package*.json ./
RUN npm ci
COPY templates.json /templates.json
COPY frontend/ ./
RUN npm run build

FROM python:3.12-slim-bookworm
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends fonts-dejavu-core fonts-noto-cjk && rm -rf /var/lib/apt/lists/*
COPY backend/requirements.txt backend/
RUN pip install --no-cache-dir -r backend/requirements.txt
COPY backend/ backend/
COPY templates.json .
COPY --from=ui /ui/dist frontend/dist
ENV HOST=0.0.0.0 COOKIE_SECURE=1
CMD ["python", "backend/app.py"]
