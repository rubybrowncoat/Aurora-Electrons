module.exports = {
  root: true,
  env: {
    browser: true,
    node: true,
  },
  parserOptions: {
    sourceType: 'module',
  },
  extends: [
    '@nuxtjs/eslint-config-typescript',
  ],
  // add your custom rules here
  rules: {
    // StandardJS — The Rules
    indent: ['error', 2, {
      'SwitchCase': 1,
      offsetTernaryExpressions: true,
    }],
    'comma-dangle': ['error', {
      arrays: 'always-multiline',
      objects: 'always-multiline',
      imports: 'always-multiline',
      exports: 'always-multiline',
      functions: 'never',
    }],
    'max-len': ['error', { code: 28000 }],
    'no-console': 'off',
    'arrow-parens': ['error', 'always'],
    curly: ['error', 'multi-line'],
    'import/no-extraneous-dependencies': 'off',
    'require-await': 0,

    'global-require': 0,
    'import/no-unresolved': 0,
    'import/newline-after-import': 0,
    'no-underscore-dangle': 0,
    'space-before-function-paren': 0,

    // A debugger statement freezes the app whenever DevTools is open, which `bun run dev` always does.
    'no-debugger': 2,

    // Lines keep their natural length and editors soft-wrap them, so nothing is broken across lines to fit a width: a condition, a ternary, an arrow's body and a start tag's attributes stay on one line, and a call's arguments share its line unless each sits on its own.
    'function-call-argument-newline': ['error', 'consistent'],
    'function-paren-newline': ['error', 'multiline'],
    'implicit-arrow-linebreak': ['error', 'beside'],
    'multiline-ternary': ['error', 'never'],
    'operator-linebreak': ['error', 'none'],
    'vue/operator-linebreak': ['error', 'none'],
    'vue/first-attribute-linebreak': ['error', { singleline: 'beside', multiline: 'beside' }],
    'vue/html-closing-bracket-newline': ['error', { singleline: 'never', multiline: 'never' }],

    'vue/max-attributes-per-line': 'off',
    'vue/multi-word-component-names': 'off',
    'vue/singleline-html-element-content-newline': 0,
    'vue/max-len': ['error', {
      code: 28000,
      template: 28000,
      tabWidth: 2,
      comments: 28000,
    }],

    'unicorn/number-literal-case': 0,
  },
}
