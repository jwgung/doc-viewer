// 렌더러 워커와 요청-응답으로 주고받는다. 같은 종류의 응답은 보낸 순서대로 돌아온다고 가정한다.
export function connect(worker) {
  const waiting = new Map();
  worker.onmessage = ({ data }) => {
    if (data.type === 'error') {
      for (const queue of waiting.values()) queue.splice(0).forEach(({ reject }) => reject(new Error(data.message)));
      return;
    }
    const key = data.index === undefined ? data.type : `${data.type}:${data.index}`;
    waiting.get(key)?.shift()?.resolve(data);
  };
  worker.onerror = (event) => {
    for (const queue of waiting.values()) queue.splice(0).forEach(({ reject }) => reject(new Error(event.message)));
  };
  return (message, replyType, transfer = []) =>
    new Promise((resolve, reject) => {
      const key = message.index === undefined ? replyType : `${replyType}:${message.index}`;
      if (!waiting.has(key)) waiting.set(key, []);
      waiting.get(key).push({ resolve, reject });
      worker.postMessage(message, transfer);
    });
}
