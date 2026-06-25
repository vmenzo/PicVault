<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue';
import { imageAssetApi } from '@/api/images';
import type { ImageItem } from '@/api/types';
import { toAbsoluteUrl } from '@/utils/url';

defineOptions({
  inheritAttrs: false,
});

const props = withDefaults(
  defineProps<{
    image: ImageItem;
    alt?: string;
    variant?: 'thumb' | 'original' | 'webp' | 'avif';
  }>(),
  {
    variant: 'thumb',
  },
);

const src = ref('');
let objectUrl = '';
let loadId = 0;

function isPublicAsset(image: ImageItem) {
  return image.status === 'READY' && image.visibility !== 'PRIVATE';
}

function directUrl(image: ImageItem) {
  const candidate =
    props.variant === 'original'
      ? image.publicUrl
      : image.thumbUrl || image.publicUrl;
  return candidate ? toAbsoluteUrl(candidate) : '';
}

function cleanupObjectUrl() {
  if (objectUrl) {
    URL.revokeObjectURL(objectUrl);
    objectUrl = '';
  }
}

async function load() {
  const currentLoad = ++loadId;
  cleanupObjectUrl();

  if (isPublicAsset(props.image)) {
    src.value = directUrl(props.image);
    return;
  }

  src.value = '';
  try {
    const blob = await imageAssetApi(props.image.id, props.variant);
    if (currentLoad !== loadId) {
      return;
    }

    objectUrl = URL.createObjectURL(blob);
    src.value = objectUrl;
  } catch {
    src.value = '';
  }
}

watch(
  () => [
    props.image.id,
    props.image.updatedAt,
    props.image.status,
    props.image.visibility,
    props.image.thumbUrl,
    props.image.publicUrl,
    props.variant,
  ],
  load,
  { immediate: true },
);

onBeforeUnmount(() => {
  loadId += 1;
  cleanupObjectUrl();
});
</script>

<template>
  <img
    v-if="src"
    v-bind="$attrs"
    :src="src"
    :alt="alt || image.title"
    loading="lazy"
  />
  <div v-else v-bind="$attrs" class="protected-image-placeholder" />
</template>
