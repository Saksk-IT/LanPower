const EFFORT_ORDER = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
function orderedEfforts(values) {
  const rank = value => { const index = EFFORT_ORDER.indexOf(value); return index < 0 ? EFFORT_ORDER.length : index; };
  return [...new Set(values)].sort((a, b) => rank(a) - rank(b));
}
const svgStyle = svg => `background-image:url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
function effortGauge(effort, model, theme = 'light') {
  const value = effort || model && model.defaultReasoningEffort || '', index = EFFORT_ORDER.indexOf(value);
  const effortKnown = index >= 0, effortAngle = effortKnown ? Math.round(-110 + index / (EFFORT_ORDER.length - 1) * 220) : 0;
  const effortArcDegrees = effortKnown ? effortAngle + 110 : 0, length = 2 * Math.PI * 10;
  const track = theme === 'dark' ? '#34373d' : '#e5e5e8';
  const arc = (color, degrees) => `<circle cx="12" cy="12" r="10" stroke="${color}" stroke-width="2" stroke-dasharray="${(degrees / 360 * length).toFixed(3)} ${length.toFixed(3)}" transform="rotate(-200 12 12)"/>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none">${arc(track, 220)}${effortKnown && effortArcDegrees > 0 ? arc('#315ff5', effortArcDegrees) : ''}</svg>`;
  return {effortKnown, effortAngle, effortArcDegrees, effortArcStyle: svgStyle(svg)};
}
function contextIndicator(usage, theme = 'light') {
  const tokens = usage && usage.currentContextTokens, window = usage && usage.modelContextWindow;
  const known = Number.isFinite(tokens) && tokens >= 0 && Number.isFinite(window) && window > 0;
  const used = known ? Math.max(0, Math.min(100, tokens / window * 100)) : null;
  const contextUsedPercent = known ? Math.round(used) : null;
  const contextPercent = known ? 100 - contextUsedPercent : null;
  const length = 2 * Math.PI * 10, filled = known ? used / 100 * length : 0;
  const track = theme === 'dark' ? '#34373d' : '#e5e5e8', ink = theme === 'dark' ? '#a2a8b1' : '#777777';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="${track}" stroke-width="2"/>${known ? `<circle cx="12" cy="12" r="10" stroke="${ink}" stroke-width="2" stroke-dasharray="${filled.toFixed(3)} ${length.toFixed(3)}" transform="rotate(-90 12 12)"/>` : ''}</svg>`;
  return {contextPercent, contextUsedPercent, contextLabel: known ? `当前上下文已用 ${contextUsedPercent}%，剩余 ${contextPercent}%；查看用量` : '当前会话上下文用量待确认；查看状态',
    contextRingStyle: svgStyle(svg)};
}
module.exports = {orderedEfforts, effortGauge, contextIndicator};
