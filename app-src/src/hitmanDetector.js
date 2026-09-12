const { exec } = require('child_process');

let launchedAt = null;
let wasRunning = false;

function checkProcessRunning(processName) {
  return new Promise((resolve, reject) => {
    exec(`tasklist /FI "IMAGENAME eq ${processName}" /FO CSV /NH`, (err, stdout) => {
      if (err) return reject(err);
      resolve(stdout.toLowerCase().includes(processName.toLowerCase()));
    });
  });
}

/**
 * Returns { running: boolean, startedAt: number|null }. startedAt is
 * captured the moment the process is first noticed, so Discord can show
 * accurate elapsed time.
 */
async function getGameStatus(processName) {
  const name = processName || 'HITMAN3.exe';
  const isRunning = await checkProcessRunning(name);

  if (isRunning && !wasRunning) launchedAt = Date.now();
  if (!isRunning) launchedAt = null;
  wasRunning = isRunning;

  return { running: isRunning, startedAt: launchedAt };
}

module.exports = { getGameStatus };
