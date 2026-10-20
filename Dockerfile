# aiKart "Try Me Now" sandbox image (submission Method 1).
# Runs the agent once on /aikart/input.json and writes /aikart/output.json.
# No npm install: the agent has no runtime dependencies and Node runs the TypeScript sources directly.
FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json ./
COPY lib ./lib
COPY data ./data
COPY scripts ./scripts
# Runs as the image default user so it can always write to the platform-mounted /aikart directory.
CMD ["node", "--disable-warning=ExperimentalWarning", "scripts/aikart-run.ts"]
