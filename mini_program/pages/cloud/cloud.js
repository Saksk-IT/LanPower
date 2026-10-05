const {ROUTES} = require('../../utils/navigation');

// Older bookmarks and preview links remain valid; new flows use dedicated pages.
Page({
  onLoad(options = {}) {
    const name = ({home: 'devices', devices: 'devices', connect: 'settings', help: 'help', codex: 'codex'})[options.tab] || 'devices';
    if ((name === 'devices' || name === 'codex') && options.computer) {
      wx.redirectTo({url: ROUTES[name === 'codex' ? 'codex' : 'power'] + '?computer=' + encodeURIComponent(options.computer)});
    } else if (name === 'help') wx.redirectTo({url: ROUTES.help});
    else wx.switchTab({url: ROUTES[name === 'codex' ? 'devices' : name]});
  }
});
