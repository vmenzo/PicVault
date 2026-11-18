<script setup lang="ts">
defineProps<{
  title?: string;
  subtitle?: string;
  /** Shows the Element Plus loading overlay on the card body. */
  loading?: boolean;
}>();
</script>

<template>
  <el-card v-loading="loading" shadow="never" class="panel-card">
    <template v-if="title || $slots.action" #header>
      <div class="panel-head">
        <div>
          <strong>{{ title }}</strong>
          <span v-if="subtitle">{{ subtitle }}</span>
        </div>
        <slot name="action" />
      </div>
    </template>
    <slot />
  </el-card>
</template>
