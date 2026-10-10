# Firebase Auth + Firestore emulators for local development (the Firestore emulator needs Java 21).
FROM node:22-trixie-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends openjdk-21-jre-headless \
  && rm -rf /var/lib/apt/lists/*
RUN npm install -g firebase-tools@15.30.2
WORKDIR /app
EXPOSE 4000 8086 9099
# a "demo-" project never talks to real Firebase servers
CMD ["firebase", "emulators:start", "--project", "demo-jobdesk2000", "--only", "auth,firestore"]
