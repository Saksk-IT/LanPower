const ROUTES = {
  codex: '/pages/codex/codex',
  power: '/pages/power/power',
  settings: '/pages/settings/settings',
  help: '/pages/help/help',
  lan: '/pages/index/index'
};

function openPage(wxApi, name, computer = '') {
  const route = ROUTES[name];
  if (!route) return;
  const pages = typeof getCurrentPages === 'function' ? getCurrentPages() : [];
  const index = pages.findIndex(page => '/' + page.route === route);
  if (index >= 0) {
    const delta = pages.length - index - 1;
    if (delta) wxApi.navigateBack({delta});
    return;
  }
  const url = route + (computer ? '?computer=' + encodeURIComponent(computer) : '');
  if (name === 'codex') wxApi.reLaunch({url});
  else wxApi.navigateTo({url});
}

module.exports = {ROUTES, openPage};
