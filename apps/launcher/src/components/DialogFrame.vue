<script setup lang="ts">
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from './ui/dialog/index.ts'
defineProps<{ open: boolean; title: string; description: string; wide?: boolean }>()
defineEmits<{ close: [] }>()
</script>
<template><Dialog :open="open" @update:open="!$event && $emit('close')"><DialogContent :class="['launcher-dialog', {'launcher-dialog-wide':wide}]"><DialogHeader><DialogTitle>{{ title }}</DialogTitle><DialogDescription>{{ description }}</DialogDescription></DialogHeader><slot /></DialogContent></Dialog></template>
