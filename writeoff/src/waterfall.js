'use strict';

// ----------------------------------------------------------------------------
// Waterfall: allocate the write-off amount across buckets in the defined order.
//
// Pure function using integer haléře. No network, configuration, or clock
// access; tests fully cover its behavior. This function determines the amount
// written off from each bucket.
//
// Invariants: allocation[b] <= buckets[b] for every bucket and
// sum(allocation) <= amount. The API returns invalidAmount if a component
// exceeds its remaining balance; avoid that condition.
// ----------------------------------------------------------------------------

function allocate({ buckets, order, amount }) {
  if (!Number.isInteger(amount)) throw new TypeError(`allocate: amount is not an integer: ${amount}`);
  if (amount < 0) throw new RangeError(`allocate: amount is negative: ${amount}`);
  if (!Array.isArray(order)) throw new TypeError('allocate: order is not an array');

  const allocation = {};
  const steps = [];
  let left = amount;

  for (const bucket of order) {
    const available = buckets[bucket] ?? 0;
    if (!Number.isInteger(available)) {
      throw new TypeError(`allocate: balance for bucket ${bucket} is not an integer: ${available}`);
    }
    if (available < 0) {
      throw new RangeError(`allocate: negative balance for bucket ${bucket}: ${available}`);
    }
    if (left === 0 || available === 0) {
      steps.push({ bucket, available, taken: 0, leftAfter: left });
      continue;
    }

    const taken = Math.min(available, left);
    allocation[bucket] = taken;
    left -= taken;
    steps.push({ bucket, available, taken, leftAfter: left, partial: taken < available });
  }

  return {
    allocation,                              // Nonzero buckets only.
    allocated: amount - left,
    shortfall: left,                         // > 0 => insufficient bucket capacity for target
    steps,                                   // Full trace for report and audit.
    capacity: order.reduce((acc, b) => acc + (buckets[b] ?? 0), 0),
  };
}

module.exports = { allocate };
