// Even Hub can use a new loopback port for each launch. Back up bounded state
// through its durable phone storage, without queueing one write per text frame.
export function installDiagnosticCheckpoint(diagnostics, storage, { delay = 1000 } = {}) {
  let timer, writing = null, pending = false, unavailable = false;
  const save = () => {
    timer = null; if (unavailable || writing || !pending) return writing;
    pending = false;
    writing = Promise.resolve().then(() => storage.write(JSON.parse(JSON.stringify(diagnostics.summary(40))))).catch(error => { if (['phone-storage-write', 'phone-storage-unavailable'].includes(error.code)) unavailable = true; }).finally(() => {
      writing = null; if (pending) schedule();
    });
    return writing;
  };
  const schedule = () => {
    if (unavailable) return;
    pending = true;
    if (!timer && !writing) timer = setTimeout(save, delay);
  };
  diagnostics.onCheckpoint = diagnostics.onError = schedule;
  // Preserve recovered evidence before allowing another potentially freezing
  // attempt. Share the existing write lane; never race two atomic snapshots.
  diagnostics.flushCheckpoint = async () => {
    if (timer) clearTimeout(timer); timer = null;
    if (writing) await writing;
    if (timer) clearTimeout(timer); timer = null;
    pending = true; await save();
  };
  if (diagnostics.errors.length) schedule();
  return schedule;
}
