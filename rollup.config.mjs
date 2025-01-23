import typescript from '@rollup/plugin-typescript'
import nodeResolve from '@rollup/plugin-node-resolve'
import commonjs from '@rollup/plugin-commonjs'

export default {
    input: 'main.ts',
    output: {
        dir: '.',
        sourcemap: true,
        format: 'cjs', // obsidian plugins must be CommonJS
        exports: 'default'
    },
    external: ['obsidian'], // let obsidian provide its own module at runtime
    plugins: [
        typescript(),
        nodeResolve({
            browser: true, // so it can bundle 'http/web' subpaths, etc.
            preferBuiltins: false, // sometimes needed if bundler tries to use Node modules
        }),
        commonjs(),
    ]
}
