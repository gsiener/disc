`wait-to-throw.swift` measures the app's `canThrow` predicate headlessly, with no input, so
the numbers in the write-up can be reproduced without a Simulator. `Waits.measure(.minis,
seed: 1, seconds: 300)` from an executable target depending on `UltimateSim`.
