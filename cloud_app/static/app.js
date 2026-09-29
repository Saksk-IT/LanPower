document.querySelectorAll('form[data-confirm]').forEach((form) => {
  form.addEventListener('submit', (event) => {
    const action = form.dataset.confirm;
    if (action && !window.confirm(`确定要让电脑${action}吗？`)) event.preventDefault();
  });
});

const resultCard = document.querySelector('[data-command-id]');
if (resultCard) {
  const commandId = resultCard.dataset.commandId;
  const title = document.getElementById('command-title');
  const progress = document.getElementById('command-progress');
  const poll = async () => {
    try {
      const response = await fetch(`/api/v2/commands/${encodeURIComponent(commandId)}`, { credentials: 'same-origin' });
      if (!response.ok) throw new Error('status unavailable');
      const result = await response.json();
      if (result.state === 'accepted') {
        window.setTimeout(poll, 1500);
        return;
      }
      title.textContent = result.state === 'completed' ? '命令已完成' : result.state === 'transitioning' ? '电脑已确认' : '操作未完成';
      progress.textContent = result.error || (result.state === 'completed' ? '电脑已确认。' : result.state === 'transitioning' ? '电脑正在执行电源操作。' : '电脑未能执行。');
    } catch {
      progress.textContent = '暂时无法取得结果，请稍后查看活动记录。';
    }
  };
  window.setTimeout(poll, 1500);
}
