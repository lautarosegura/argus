process.on('message', (msg) => {
  if (msg.type === 'ping') {
    process.send({ type: 'pong', workspaceId: process.env.ARGUS_WORKSPACE_ID });
  }
});

process.send({ type: 'ready', workspaceId: process.env.ARGUS_WORKSPACE_ID });
