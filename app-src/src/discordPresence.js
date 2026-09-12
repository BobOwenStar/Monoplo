const DiscordRPC = require('discord-rpc');

let client = null;
let ready = false;

function login(clientId) {
  return new Promise((resolve, reject) => {
    const c = new DiscordRPC.Client({ transport: 'ipc' });

    c.once('ready', () => {
      ready = true;
      resolve();
    });

    c.on('disconnected', () => {
      ready = false;
    });

    c.login({ clientId }).catch(reject);
    client = c;
  });
}

/**
 * Connects (or reconnects, if a previous connection exists) using the
 * given Discord Application Client ID.
 */
async function connect(clientId) {
  if (client) {
    try {
      client.destroy();
    } catch {
      // already dead, ignore
    }
    client = null;
    ready = false;
  }
  await login(clientId);
}

async function setActivity(activity) {
  if (!ready || !client) return;
  try {
    await client.setActivity(activity);
  } catch (err) {
    console.error('[discord] failed to set activity:', err.message);
  }
}

async function clearActivity() {
  if (!ready || !client) return;
  try {
    await client.clearActivity();
  } catch (err) {
    console.error('[discord] failed to clear activity:', err.message);
  }
}

function isReady() {
  return ready;
}

function disconnect() {
  if (client) {
    try {
      client.destroy();
    } catch {
      // ignore
    }
  }
  client = null;
  ready = false;
}

module.exports = { connect, setActivity, clearActivity, isReady, disconnect };
