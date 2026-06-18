setInterval(() => {
  chrome.runtime.sendMessage({ type: 'keepalive' }).catch(() => {});
}, 20000);

setTimeout(() => {
  chrome.runtime.sendMessage({ type: 'keepalive' }).catch(() => {});
}, 1000);
