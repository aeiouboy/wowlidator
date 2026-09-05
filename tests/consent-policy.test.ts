import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { isFlow } from '../src/cli/artifacts.js';

describe('consent policy flow boundary', () => {
  it('rejects an unknown consent policy at the flow-file boundary', () => {
    // Given: an otherwise valid flow file with an unsupported policy value.
    const input = { name: 'invalid policy', consentPolicy: 'skip', steps: [] };

    // When: the CLI parses the external file shape.
    const accepted = isFlow(input);

    // Then: the invalid policy is rejected before runtime execution.
    assert.equal(accepted, false);
  });
});
