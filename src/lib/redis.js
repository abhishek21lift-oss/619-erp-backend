const Redis = require('ioredis');
const logger = require('./logger');

const host = process.env.REDIS_HOST || 'redis';
const port = Number(process.env.REDIS_PORT ?? 6379) || 6379;

let redisClient;

function createRedisClient() {
  const client = new Redis({
    host,
    port,
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    lazyConnect: true,
  });

  client.on('connect', () => {
    logger.info({ host, port }, 'Redis connected');
  });

  client.on('ready', () => {
    logger.info({ host, port }, 'Redis ready');
  });

  client.on('error', (err) => {
    logger.error({ err, host, port }, 'Redis error');
  });

  client.on('close', () => {
    logger.warn({ host, port }, 'Redis connection closed');
  });

  return client;
}

function getRedisClient() {
  if (!redisClient) {
    redisClient = createRedisClient();
  }
  return redisClient;
}

module.exports = getRedisClient();