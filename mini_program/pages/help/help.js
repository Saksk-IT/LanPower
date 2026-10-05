const {VERSION} = require('../../utils/version');
const {environment} = require('../../utils/environment');
const {openPage} = require('../../utils/navigation');

Page({
  data: {version: VERSION, environmentLabel: '', helpTopic: 'remote', faqOpen: ''},
  onLoad() { this.setData({environmentLabel: environment(wx).label}); },
  selectHelpTopic(event) { const topic = event.currentTarget.dataset.topic; if (['remote', 'lan', 'wake'].includes(topic)) this.setData({helpTopic: topic}); },
  toggleFaq(event) { const faq = event.currentTarget.dataset.faq; this.setData({faqOpen: this.data.faqOpen === faq ? '' : faq}); },
  openCodex() { openPage(wx, 'codex'); },
  openSettings() { openPage(wx, 'settings'); },
  openPower() { openPage(wx, 'power'); },
  openLocal() { openPage(wx, 'lan'); }
});
