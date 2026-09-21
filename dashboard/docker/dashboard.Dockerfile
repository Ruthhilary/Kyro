# Kyro Dashboard
FROM node:20-alpine AS builder
WORKDIR /app

# Accept build-time env vars for Next.js NEXT_PUBLIC_ substitution
ARG NEXT_PUBLIC_API_URL=http://localhost:8001
ARG NEXT_PUBLIC_WS_URL=ws://localhost:8001
ARG NEXT_PUBLIC_CAMERA_ID=cam-01
ARG NEXT_PUBLIC_DEMO=false
ARG NEXT_PUBLIC_DEMO_USER=admin
ARG NEXT_PUBLIC_DEMO_PASS=
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_WS_URL=$NEXT_PUBLIC_WS_URL
ENV NEXT_PUBLIC_CAMERA_ID=$NEXT_PUBLIC_CAMERA_ID
ENV NEXT_PUBLIC_DEMO=$NEXT_PUBLIC_DEMO
ENV NEXT_PUBLIC_DEMO_USER=$NEXT_PUBLIC_DEMO_USER
ENV NEXT_PUBLIC_DEMO_PASS=$NEXT_PUBLIC_DEMO_PASS

COPY dashboard/package.json .
RUN npm install
COPY dashboard/ .
RUN npm run build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
# public/ must be copied explicitly — standalone mode doesn't include it
COPY --from=builder /app/public ./public
EXPOSE 3000
CMD ["node", "server.js"]
