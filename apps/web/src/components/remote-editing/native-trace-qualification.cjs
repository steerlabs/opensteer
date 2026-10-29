function qualifyNativeTrace({ scenario, events, final }) {
  const input = events.filter((event) => /^(key|input|beforeinput|composition)/.test(event.type));
  if (!input.length || input.some((event) => event.trusted !== true)) return false;
  if (final.value !== scenario.expected || final.composing) return false;
  let active = false;
  let completed = 0;
  for (const event of input) {
    if (event.type === "compositionstart") {
      if (active) return false;
      active = true;
    } else if (event.type === "compositionend") {
      if (!active) return false;
      active = false;
      completed++;
    }
  }
  return (
    !active && completed >= (scenario.compositionTransactions ?? (scenario.composition ? 1 : 0))
  );
}
module.exports = { qualifyNativeTrace };
