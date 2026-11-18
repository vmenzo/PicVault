<script setup lang="ts">
defineProps<{
  /** Small kicker above the title, e.g. "资产工作台". */
  eyebrow?: string;
  title: string;
  subtitle?: string;
}>();
</script>

<template>
  <header class="pv-page-header">
    <div>
      <span v-if="eyebrow" class="pv-page-header-eyebrow">{{ eyebrow }}</span>
      <h1>{{ title }}</h1>
      <p v-if="subtitle">{{ subtitle }}</p>
    </div>
    <div v-if="$slots.actions" class="pv-page-header-actions">
      <slot name="actions" />
    </div>
  </header>
</template>
