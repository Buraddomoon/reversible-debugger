/** Shared by Vitest, the local benchmark and the native Firefox probe. */
export const stressRuntime = { language: 'python', version: '3' } as const;
export const stressFixtures = [
  { id: 'large-list', name: 'Lista com delta indivisível', oversizedOp: 'BUILD_LIST',
    source: `n = 10 ** 4000\na = [${Array.from({ length: 80 }, () => 'n').join(', ')}]\nb = a\na.append(a)\nb[0] = 1\nresult = len(a)\nprint(result)` },
  { id: 'large-return', name: 'Retorno com frame grande', oversizedOp: 'RETURN',
    source: `n = 10 ** 4000\ndef release(v):\n${Array.from({ length: 90 }, (_, i) => `    local${i} = v`).join('\n')}\n    return 42\nresult = release(n)\nprint(result)` },
  { id: 'checkpoint-pressure', name: 'Saída e redução de checkpoints', oversizedOp: null,
    source: 'n = 10 ** 2000\ni = 0\nwhile i < 400:\n    print(n)\n    i += 1\nresult = i' },
] as const;
