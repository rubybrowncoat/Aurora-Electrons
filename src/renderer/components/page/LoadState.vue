<template>
  <v-alert v-if="failed" type="error" outlined dense>
    Couldn't read {{ failed }}: {{ error }}. The game may be saving; the page reads the save again when it changes.
    <template #append>
      <v-btn small text color="error" @click="$emit('retry')">Retry</v-btn>
    </template>
  </v-alert>
  <v-progress-linear v-else-if="loading" indeterminate />
</template>

<script>
// What a page shows above its content until its reads are in: the failed reads with a Retry button, else a progress
// bar while loading. With the load-state mixin a page passes `failedInputsText`, `loadErrors[failedInputs[0]]`,
// `!ready` and `retryFailedInputs`.
export default {
  name: 'LoadState',
  props: {
    // The failed reads, named ("the jump points and your colonies"); empty while none has failed.
    failed: {
      type: String,
      default: '',
    },
    // The first failed read's message.
    error: {
      type: String,
      default: '',
    },
    loading: {
      type: Boolean,
      default: false,
    },
  },
}
</script>
