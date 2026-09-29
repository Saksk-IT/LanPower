document.querySelectorAll('form[data-confirm]').forEach((form) => {
  form.addEventListener('submit', (event) => {
    const action = form.dataset.confirm;
    if (action && !window.confirm(`确定要让电脑${action}吗？`)) event.preventDefault();
  });
});
