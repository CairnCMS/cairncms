<template>
	<sidebar-detail icon="info" :title="t('information')" close>
		<dl v-if="parsedInfo">
			<div>
				<!-- TODO: rename the `directus_version` i18n key to something neutral (`app_version` or `product_version`) in a later localization sweep. -->
				<dt>{{ t('directus_version') }}</dt>
				<dd>{{ parsedInfo.cairncms.version }}</dd>
			</div>
			<div>
				<dt>{{ t('node_version') }}</dt>
				<dd>{{ parsedInfo.node.version }}</dd>
			</div>
			<div>
				<dt>{{ t('node_uptime') }}</dt>
				<dd>{{ parsedInfo.node.uptime }}</dd>
			</div>
			<div>
				<dt>{{ t('os_type') }}</dt>
				<dd>{{ parsedInfo.os.type }}</dd>
			</div>
			<div>
				<dt>{{ t('os_version') }}</dt>
				<dd>{{ parsedInfo.os.version }}</dd>
			</div>
			<div>
				<dt>{{ t('os_uptime') }}</dt>
				<dd>{{ parsedInfo.os.uptime }}</dd>
			</div>
			<div>
				<dt>{{ t('os_totalmem') }}</dt>
				<dd>{{ parsedInfo.os.totalmem }}</dd>
			</div>
		</dl>

		<v-divider />

		<div v-md="t('page_help_settings_project')" class="page-description" />
	</sidebar-detail>
</template>

<script lang="ts">
import { useI18n } from 'vue-i18n';
import { defineComponent } from 'vue';
import { useProjectInfo } from '../../../composables/use-project-info';

export default defineComponent({
	setup() {
		const { t } = useI18n();

		const { parsedInfo } = useProjectInfo();

		return { t, parsedInfo };
	},
});
</script>

<style lang="scss" scoped>
.v-divider {
	margin: 20px 0;
}
</style>
