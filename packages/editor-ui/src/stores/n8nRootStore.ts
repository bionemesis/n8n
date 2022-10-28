import { IRestApiContext, rootStatePinia } from '@/Interface';
import { IDataObject } from 'n8n-workflow';
import { defineStore } from 'pinia';
import Vue from 'vue';

export const useRootStore = defineStore('root', {
	state: (): rootStatePinia => ({
		// @ts-ignore
		baseUrl: import.meta.env.VUE_APP_URL_BASE_API ? import.meta.env.VUE_APP_URL_BASE_API : (window.BASE_PATH === '/%BASE_PATH%/' ? '/' : window.BASE_PATH),
		defaultLocale: 'en',
		endpointWebhook: 'webhook',
		endpointWebhookTest: 'webhook-test',
		pushConnectionActive: true,
		timezone: 'America/New_York',
		executionTimeout: -1,
		maxExecutionTimeout: Number.MAX_SAFE_INTEGER,
		versionCli: '0.0.0',
		oauthCallbackUrls: {},
		n8nMetadata: {},
		sessionId: Math.random().toString(36).substring(2, 15),
		urlBaseWebhook: 'http://localhost:5678/',
		urlBaseEditor: 'http://localhost:5678',
		isNpmAvailable: false,
		instanceId: '',
	}),
	getters: {
		// TODO: Waiting for nodetypes store

		/**
		 * Getter for node default names ending with a number: `'S3'`, `'Magento 2'`, etc.
		 */
		//  nativelyNumberSuffixedDefaults: (_, getters): string[] => {
		// 	const { 'nodeTypes/allNodeTypes': allNodeTypes } = getters as {
		// 		['nodeTypes/allNodeTypes']: Array<INodeTypeDescription & { defaults: { name: string } }>;
		// 	};

		// 	return allNodeTypes.reduce<string[]>((acc, cur) => {
		// 		if (/\d$/.test(cur.defaults.name)) acc.push(cur.defaults.name);
		// 		return acc;
		// 	}, []);
		// },
		getWebhookUrl(): string {
			return `${this.urlBaseWebhook}${this.endpointWebhook}`;
		},

		getWebhookTestUrl(): string {
			return `${this.urlBaseEditor}${this.endpointWebhookTest}`;
		},

		getRestUrl: (state: rootStatePinia): string => {
			let endpoint = 'rest';
			if (import.meta.env.VUE_APP_ENDPOINT_REST) {
				endpoint = import.meta.env.VUE_APP_ENDPOINT_REST;
			}
			return `${state.baseUrl}${endpoint}`;
		},

		getRestApiContext: (state: rootStatePinia): IRestApiContext => {
			let endpoint = 'rest';
			if (import.meta.env.VUE_APP_ENDPOINT_REST) {
				endpoint = import.meta.env.VUE_APP_ENDPOINT_REST;
			}
			return {
				baseUrl: `${state.baseUrl}${endpoint}`,
				sessionId: state.sessionId,
			};
		},
	},
	actions: {
		setUrlBaseWebhook(urlBaseWebhook: string) {
			const url = urlBaseWebhook.endsWith('/') ? urlBaseWebhook : `${urlBaseWebhook}/`;
			Vue.set(this, 'urlBaseWebhook', url);
		},
		setUrlBaseEditor(urlBaseEditor: string) {
			const url = urlBaseEditor.endsWith('/') ? urlBaseEditor : `${urlBaseEditor}/`;
			Vue.set(this, 'urlBaseEditor', url);
		},
		setEndpointWebhook(endpointWebhook: string) {
			Vue.set(this, 'endpointWebhook', endpointWebhook);
		},
		setEndpointWebhookTest(endpointWebhookTest: string) {
			Vue.set(this, 'endpointWebhookTest', endpointWebhookTest);
		},
		setTimezone(timezone: string) {
			Vue.set(this, 'timezone', timezone);
		},
		setExecutionTimeout(executionTimeout: number) {
			Vue.set(this, 'executionTimeout', executionTimeout);
		},
		setMaxExecutionTimeout(maxExecutionTimeout: number) {
			Vue.set(this, 'maxExecutionTimeout', maxExecutionTimeout);
		},
		setVersionCli(version: string) {
			Vue.set(this, 'versionCli', version);
		},
		setInstanceId(instanceId: string) {
			Vue.set(this, 'instanceId', instanceId);
		},
		setOauthCallbackUrls(urls: IDataObject) {
			Vue.set(this, 'oauthCallbackUrls', urls);
		},
		setN8nMetadata(metadata: IDataObject) {
			Vue.set(this, 'n8nMetadata', metadata);
		},
		setDefaultLocale(locale: string) {
			Vue.set(this, 'defaultLocale', locale);
		},
		setIsNpmAvailable(isNpmAvailable: boolean) {
			Vue.set(this, 'isNpmAvailable', isNpmAvailable);
		},
	},
});
