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
    indent: ['error', 2, { offsetTernaryExpressions: true }], // 2 spaces – for indentation
    'comma-dangle': ['error', 'always-multiline'],
    'max-len': ['error', { code: 8000 }],
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

    'no-debugger': process.env.NODE_ENV === 'production' ? 2 : 0,

    'vue/max-attributes-per-line': 'off',
    'vue/multi-word-component-names': 'off',
    'vue/singleline-html-element-content-newline': 0,
    'vue/max-len': ['error', {
      code: 8000,
      template: 8000,
      tabWidth: 2,
      comments: 8000,
    }],
  },
}
