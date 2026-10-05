const {ROUTES} = require('../../utils/navigation');

// Older bookmarks and preview links remain valid; new flows use dedicated pages.
Page({
  onLoad(options = {}) {
    const name = ({home: 'power', devices: 'power', connect: 'settings', help: 'help'})[options.tab] || 'codex';
    wx.redirectTo({url: ROUTES[name] + (options.computer ? '?computer=' + encodeURIComponent(options.computer) : '')});
  }
});
