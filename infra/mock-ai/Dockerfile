# TASK-INF-014 — mock OpenAI-compatible provider (dev/CI/load). No deps.
FROM node:22-alpine

WORKDIR /app
COPY server.js .

ENV NODE_ENV=production
EXPOSE 8787

# unprivileged
USER node
CMD ["node", "server.js"]
