const DEFAULT_NAVIGATION = {statusTop: 24, height: 44, right: 104};

function navigationLayout(wxApi) {
  const read = method => {
    try { return typeof wxApi[method] === 'function' ? wxApi[method]() || {} : {}; }
    catch (_) { return {}; }
  };
  let window = read('getWindowInfo');
  if (!Number.isFinite(window.windowWidth)) window = read('getSystemInfoSync');
  const width = Number.isFinite(window.windowWidth) && window.windowWidth > 0 ? window.windowWidth : 375;
  const top = Number.isFinite(window.statusBarHeight) ? window.statusBarHeight : window.safeArea && window.safeArea.top;
  const statusTop = Number.isFinite(top) && top >= 0 ? top : DEFAULT_NAVIGATION.statusTop;
  const capsule = read('getMenuButtonBoundingClientRect');
  const valid = [capsule.left, capsule.right, capsule.top, capsule.height].every(Number.isFinite)
    && capsule.left > width / 2 && capsule.right > capsule.left && capsule.right <= width
    && capsule.top >= statusTop && capsule.top - statusTop <= 24 && capsule.height > 0 && capsule.height <= 48;
  return {statusTop,
    height: valid ? Math.max(44, (capsule.top - statusTop) * 2 + capsule.height) : DEFAULT_NAVIGATION.height,
    right: valid ? width - capsule.left + 8 : DEFAULT_NAVIGATION.right};
}

module.exports = {DEFAULT_NAVIGATION, navigationLayout};
