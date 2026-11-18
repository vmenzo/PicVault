<script setup lang="ts">
defineProps<{
  label: string;
  value: string | number;
  /** Small caption under the value. */
  hint?: string;
  /** When set, the card is a button that emits `click`. */
  clickable?: boolean;
}>();

defineEmits<{
  click: [];
}>();
</script>

<template>
  <button
    v-if="clickable"
    type="button"
    class="metric-card"
    @click="$emit('click')"
  >
    <span>{{ label }}</span>
    <strong>{{ value }}</strong>
    <small v-if="hint">{{ hint }}</small>
  </button>
  <div v-else class="metric-card" role="group" :aria-label="label">
    <span>{{ label }}</span>
    <strong>{{ value }}</strong>
    <small v-if="hint">{{ hint }}</small>
  </div>
</template>
