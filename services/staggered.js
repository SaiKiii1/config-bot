// services/staggered.js
import { DEFAULT_STAGGER_SEC } from '../config/constants.js';
import { startRunner } from './runner.js';

export function recoverStaggeredRollouts(store, saveStore, refreshCard, nextUserSlot = new Map()) {
  if (!store.staggered || typeof store.staggered !== 'object') return;

  const now = Date.now();
  let changed = false;

  for (const [userKey, rollout] of Object.entries(store.staggered)) {
    if (!rollout || rollout.status !== 'active') {
      delete store.staggered[userKey];
      changed = true;
      continue;
    }

    const pendingIds = (rollout.queue || []).filter((cfgId) => {
      const cfg = store.configs[cfgId];
      return cfg && !cfg.running;
    });

    if (pendingIds.length === 0) {
      delete store.staggered[userKey];
      changed = true;
      continue;
    }

    const gapMs = Number(rollout.delayMs) || DEFAULT_STAGGER_SEC * 1000;
    const userId = rollout.userId || userKey.split(':')[1];
    let slot = Math.max(now + 3000, nextUserSlot.get(userId) ?? now + 3000);

    for (const cfgId of pendingIds) {
      const cfg = store.configs[cfgId];
      if (!cfg) continue;

      cfg.running = true;
      cfg.lastError = null;
      cfg.startedAt = slot;

      const initialDelaySec = Math.max(3, Math.round((slot - now) / 1000));
      startRunner(cfgId, false, store, saveStore, refreshCard, initialDelaySec);
      if (refreshCard) refreshCard(cfgId).catch(() => {});

      slot += gapMs;
    }

    nextUserSlot.set(userId, slot);
    delete store.staggered[userKey];
    changed = true;
  }

  if (changed) saveStore(store);
}