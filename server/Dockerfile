FROM node:22-slim

WORKDIR /app

# Copy package files
COPY package.json ./

# Install dependencies
RUN npm install

# Copy source files
COPY tsconfig.json ./
COPY src ./src

# Build TypeScript
RUN npm run build

# Expose port
EXPOSE 3000

# Start server
CMD ["npm", "start"]
