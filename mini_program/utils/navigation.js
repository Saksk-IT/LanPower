const ROUTES = {
  devices: '/pages/devices/devices',
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
  if (name === 'devices' || name === 'settings') {
    if (!pages.length || '/' + pages[pages.length - 1].route !== route) wxApi.switchTab({url: route});
    return;
  }
  let index = -1;
  for (let position = pages.length - 1; position >= 0; position--) {
    const page = pages[position];
    const target = page.targetDevice || (page.options && page.options.computer) || (page.data && (page.data.deviceId || page.data.selectedId));
    if ('/' + page.route === route && (!computer || target === computer)) { index = position; break; }
  }
  if (index >= 0) {
    const delta = pages.length - index - 1;
    if (delta) wxApi.navigateBack({delta});
    return;
  }
  if ((name === 'power' || name === 'codex') && !computer) {
    wxApi.switchTab({url: ROUTES.devices});
    return;
  }
  const url = route + (computer ? '?computer=' + encodeURIComponent(computer) : '');
  wxApi.navigateTo({url});
}

module.exports = {ROUTES, openPage};
