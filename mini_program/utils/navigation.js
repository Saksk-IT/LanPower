const ROUTES = {
  devices: '/pages/devices/devices',
  codex: '/pages/codex/codex',
  power: '/pages/power/power',
  settings: '/pages/settings/settings',
  help: '/pages/help/help',
  lan: '/pages/index/index'
};

function pageRoute(page) {
  return page && typeof page.route === 'string' ? '/' + page.route.replace(/^\/+/, '').split('?')[0] : '';
}

function pageDevice(page) {
  return page && (page.targetDevice || (page.options && page.options.computer) || (page.data && (page.data.deviceId || page.data.selectedId)));
}

function returnToDevice(wxApi, computer = '') {
  const pages = typeof getCurrentPages === 'function' ? getCurrentPages() : [];
  const reset = () => wxApi.switchTab({
    url: ROUTES.devices,
    ...(computer ? {success: () => wxApi.navigateTo({url: ROUTES.power + '?computer=' + encodeURIComponent(computer)})} : {})
  });
  if (!computer) { reset(); return; }
  // 回到列表之上的原详情，清掉旧版导航留下的重复详情和 Codex 页面。
  if (pageRoute(pages[0]) === ROUTES.devices && pageRoute(pages[1]) === ROUTES.power && pageDevice(pages[1]) === computer) {
    const delta = pages.length - 2;
    if (delta > 0) wxApi.navigateBack({delta, fail: reset});
    return;
  }
  // 直达链接或父页面无法确认时，先关闭旧页面栈，再建立列表 → 当前设备详情。
  reset();
}

function openPage(wxApi, name, computer = '') {
  const route = ROUTES[name];
  if (!route) return;
  const pages = typeof getCurrentPages === 'function' ? getCurrentPages() : [];
  if (name === 'devices' || name === 'settings') {
    if (!pages.length || pageRoute(pages[pages.length - 1]) !== route) wxApi.switchTab({url: route});
    return;
  }
  if (name === 'power' && pageRoute(pages[pages.length - 1]) === ROUTES.codex) {
    returnToDevice(wxApi, computer);
    return;
  }
  let index = -1;
  for (let position = pages.length - 1; position >= 0; position--) {
    const page = pages[position];
    if (pageRoute(page) === route && (!computer || pageDevice(page) === computer)) { index = position; break; }
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

module.exports = {ROUTES, openPage, returnToDevice};
