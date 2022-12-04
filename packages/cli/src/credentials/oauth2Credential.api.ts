/* eslint-disable import/no-cycle */
import Csrf from 'csrf';
import express from 'express';
import get from 'lodash.get';
import omit from 'lodash.omit';
import set from 'lodash.set';
import split from 'lodash.split';
import unset from 'lodash.unset';
import querystring from 'querystring';
import { Credentials, UserSettings } from 'n8n-core';
import {
	LoggerProxy,
	WorkflowExecuteMode,
	INodeCredentialsDetails,
	ICredentialsEncrypted,
	IDataObject,
} from 'n8n-workflow';
import { resolve as pathResolve } from 'path';

import * as Db from '@/Db';
import * as ResponseHelper from '@/ResponseHelper';
import { ICredentialsDb } from '@/Interfaces';
import { RESPONSE_ERROR_MESSAGES, TEMPLATES_DIR } from '@/constants';
import {
	CredentialsHelper,
	getCredentialForUser,
	getCredentialWithoutUser,
} from '@/CredentialsHelper';
import { getLogger } from '@/Logger';
import { OAuthRequest } from '@/requests';
import { externalHooks } from '@/Server';
import config from '@/config';
import { getInstanceBaseUrl, getUserById } from '@/UserManagement/UserManagementHelper';
import { exponentialBuckets } from 'prom-client';

export const oauth2CredentialController = express.Router();
export interface OAuth2Parameters {
	clientId?: string;
	clientSecret?: string;
	accessTokenUri?: string;
	authorizationUri?: string;
	redirectUri?: string;
	scopes?: string[];
	state?: string;
	body?: {
		[key: string]: string | string[];
	};
	query?: {
		[key: string]: string | string[];
	};
	headers?: {
		[key: string]: string | string[];
	};
}

/**
 * Initialize Logger if needed
 */
oauth2CredentialController.use((req, res, next) => {
	try {
		LoggerProxy.getInstance();
	} catch (error) {
		LoggerProxy.init(getLogger());
	}
	next();
});

const restEndpoint = config.getEnv('endpoints.rest');

/**
 * GET /oauth2-credential/auth
 *
 * Authorize OAuth Data
 */
oauth2CredentialController.get(
	'/auth',
	ResponseHelper.send(async (req: OAuthRequest.OAuth1Credential.Auth): Promise<string> => {
		const { id: credentialId } = req.query;

		if (!credentialId) {
			throw new ResponseHelper.BadRequestError('Required credential ID is missing');
		}

		const credential = await getCredentialForUser(credentialId, req.user);

		if (!credential) {
			LoggerProxy.error('Failed to authorize OAuth2 due to lack of permissions', {
				userId: req.user.id,
				credentialId,
			});
			throw new ResponseHelper.NotFoundError(RESPONSE_ERROR_MESSAGES.NO_CREDENTIAL);
		}

		let encryptionKey: string;
		try {
			encryptionKey = await UserSettings.getEncryptionKey();
		} catch (error) {
			throw new ResponseHelper.InternalServerError((error as Error).message);
		}

		const mode: WorkflowExecuteMode = 'internal';
		const timezone = config.getEnv('generic.timezone');
		const credentialsHelper = new CredentialsHelper(encryptionKey);
		const decryptedDataOriginal = await credentialsHelper.getDecrypted(
			credential as INodeCredentialsDetails,
			(credential as unknown as ICredentialsEncrypted).type,
			mode,
			timezone,
			true,
		);

		// At some point in the past we saved hidden scopes to credentials (but shouldn't)
		// Delete scope before applying defaults to make sure new scopes are present on reconnect
		if (decryptedDataOriginal?.scope) {
			delete decryptedDataOriginal.scope;
		}

		const oauthCredentials = credentialsHelper.applyDefaultsAndOverwrites(
			decryptedDataOriginal,
			(credential as unknown as ICredentialsEncrypted).type,
			mode,
			timezone,
		);

		const token = new Csrf();
		// Generate a CSRF prevention token and send it as a OAuth2 state stringma/ERR
		const csrfSecret = token.secretSync();
		const state = {
			token: token.create(csrfSecret),
			cid: req.query.id,
		};
		const stateEncodedStr = Buffer.from(JSON.stringify(state)).toString('base64');

		const oAuthOptions: OAuth2Parameters = {
			clientId: get(oauthCredentials, 'clientId') as string,
			clientSecret: get(oauthCredentials, 'clientSecret', '') as string,
			accessTokenUri: get(oauthCredentials, 'accessTokenUrl', '') as string,
			authorizationUri: get(oauthCredentials, 'authUrl', '') as string,
			redirectUri: `${getInstanceBaseUrl()}/${restEndpoint}/oauth2-credential/callback`,
			scopes: split(get(oauthCredentials, 'scope', 'openid,') as string, ','),
			state: stateEncodedStr,
		};

		await externalHooks.run('oauth2.authenticate', [oAuthOptions]);

		// Encrypt the data
		const credentials = new Credentials(
			credential as INodeCredentialsDetails,
			(credential as unknown as ICredentialsEncrypted).type,
			(credential as unknown as ICredentialsEncrypted).nodesAccess,
		);
		decryptedDataOriginal.csrfSecret = csrfSecret;

		credentials.setData(decryptedDataOriginal, encryptionKey);
		const newCredentialsData = credentials.getDataToSave() as unknown as ICredentialsDb;

		// Add special database related data
		newCredentialsData.updatedAt = new Date();

		// Update the credentials in DB
		await Db.collections.Credentials.update(req.query.id, newCredentialsData);

		const authQueryParameters = get(oauthCredentials, 'authQueryParameters', '') as string;
		let returnUri = getUri(oAuthOptions, 'token') as string;

		// if scope uses comma, change it as the library always return then with spaces
		if ((get(oauthCredentials, 'scope') as string).includes(',')) {
			const data = returnUri.split('?')[1];
			const scope = get(oauthCredentials, 'scope') as string;
			const percentEncoded = [data, `scope=${encodeURIComponent(scope)}`].join('&');
			returnUri = `${get(oauthCredentials, 'authUrl', '') as string}?${percentEncoded}`;
		}

		if (authQueryParameters) {
			returnUri += `&${authQueryParameters}`;
		}

		LoggerProxy.verbose('OAuth2 authentication successful for new credential', {
			userId: req.user.id,
			credentialId,
		});
		return returnUri;
	}),
);

/**
 * GET /oauth2-credential/callback
 *
 * Verify and store app code. Generate access tokens and store for respective credential.
 */

oauth2CredentialController.get(
	'/callback',
	async (req: OAuthRequest.OAuth2Credential.Callback, res: express.Response) => {
		try {
			// realmId it's currently just use for the quickbook OAuth2 flow
			const { code, state: stateEncoded } = req.query;

			if (!code || !stateEncoded) {
				const errorResponse = new ResponseHelper.ServiceUnavailableError(
					`Insufficient parameters for OAuth2 callback. Received following query parameters: ${JSON.stringify(
						req.query,
					)}`,
				);
				return ResponseHelper.sendErrorResponse(res, errorResponse);
			}

			let state;
			try {
				state = JSON.parse(Buffer.from(stateEncoded, 'base64').toString()) as {
					cid: string;
					token: string;
				};
			} catch (error) {
				const errorResponse = new ResponseHelper.ServiceUnavailableError(
					'Invalid state format returned',
				);
				return ResponseHelper.sendErrorResponse(res, errorResponse);
			}

			const credential = await getCredentialWithoutUser(state.cid);

			if (!credential) {
				LoggerProxy.error('OAuth2 callback failed because of insufficient permissions', {
					userId: req.user?.id,
					credentialId: state.cid,
				});
				const errorResponse = new ResponseHelper.NotFoundError(
					RESPONSE_ERROR_MESSAGES.NO_CREDENTIAL,
				);
				return ResponseHelper.sendErrorResponse(res, errorResponse);
			}

			let encryptionKey: string;
			try {
				encryptionKey = await UserSettings.getEncryptionKey();
			} catch (error) {
				throw new ResponseHelper.InternalServerError((error as IDataObject).message as string);
			}

			const mode: WorkflowExecuteMode = 'internal';
			const timezone = config.getEnv('generic.timezone');
			const credentialsHelper = new CredentialsHelper(encryptionKey);
			const decryptedDataOriginal = await credentialsHelper.getDecrypted(
				credential as INodeCredentialsDetails,
				(credential as unknown as ICredentialsEncrypted).type,
				mode,
				timezone,
				true,
			);
			const oauthCredentials = credentialsHelper.applyDefaultsAndOverwrites(
				decryptedDataOriginal,
				(credential as unknown as ICredentialsEncrypted).type,
				mode,
				timezone,
			);

			const token = new Csrf();
			if (
				decryptedDataOriginal.csrfSecret === undefined ||
				!token.verify(decryptedDataOriginal.csrfSecret as string, state.token)
			) {
				LoggerProxy.debug('OAuth2 callback state is invalid', {
					userId: req.user?.id,
					credentialId: state.cid,
				});
				const errorResponse = new ResponseHelper.NotFoundError(
					'The OAuth2 callback state is invalid!',
				);
				return ResponseHelper.sendErrorResponse(res, errorResponse);
			}

			let options = {};

			const oAuth2Parameters = {
				clientId: get(oauthCredentials, 'clientId') as string,
				clientSecret: get(oauthCredentials, 'clientSecret', '') as string | undefined,
				accessTokenUri: get(oauthCredentials, 'accessTokenUrl', '') as string,
				authorizationUri: get(oauthCredentials, 'authUrl', '') as string,
				redirectUri: `${getInstanceBaseUrl()}/${restEndpoint}/oauth2-credential/callback`,
				scopes: split(get(oauthCredentials, 'scope', 'openid,') as string, ','),
			};

			if ((get(oauthCredentials, 'authentication', 'header') as string) === 'body') {
				options = {
					body: {
						client_id: get(oauthCredentials, 'clientId') as string,
						client_secret: get(oauthCredentials, 'clientSecret', '') as string,
					},
				};
				delete oAuth2Parameters.clientSecret;
			}

			await externalHooks.run('oauth2.callback', [oAuth2Parameters]);

			//const oAuthObj = new ClientOAuth2(oAuth2Parameters);

			const queryParameters = req.originalUrl.split('?').splice(1, 1).join('');

			const oauthToken = await getToken(
				`${oAuth2Parameters.redirectUri}?${queryParameters}`,
				options,
			);

			if (Object.keys(req.query).length > 2) {
				set(oauthToken.data, 'callbackQueryString', omit(req.query, 'state', 'code'));
			}

			if (oauthToken === undefined) {
				LoggerProxy.error('OAuth2 callback failed: unable to get access tokens', {
					userId: req.user?.id,
					credentialId: state.cid,
				});
				const errorResponse = new ResponseHelper.NotFoundError('Unable to get access tokens!');
				return ResponseHelper.sendErrorResponse(res, errorResponse);
			}

			if (decryptedDataOriginal.oauthTokenData) {
				// Only overwrite supplied data as some providers do for example just return the
				// refresh_token on the very first request and not on subsequent ones.
				Object.assign(decryptedDataOriginal.oauthTokenData, oauthToken.data);
			} else {
				// No data exists so simply set
				decryptedDataOriginal.oauthTokenData = oauthToken.data;
			}

			// eslint-disable-next-line @typescript-eslint/no-unsafe-call
			unset(decryptedDataOriginal, 'csrfSecret');

			const credentials = new Credentials(
				credential as INodeCredentialsDetails,
				(credential as unknown as ICredentialsEncrypted).type,
				(credential as unknown as ICredentialsEncrypted).nodesAccess,
			);
			credentials.setData(decryptedDataOriginal, encryptionKey);
			const newCredentialsData = credentials.getDataToSave() as unknown as ICredentialsDb;
			// Add special database related data
			newCredentialsData.updatedAt = new Date();
			// Save the credentials in DB
			await Db.collections.Credentials.update(state.cid, newCredentialsData);
			LoggerProxy.verbose('OAuth2 callback successful for new credential', {
				userId: req.user?.id,
				credentialId: state.cid,
			});

			return res.sendFile(pathResolve(TEMPLATES_DIR, 'oauth-callback.html'));
		} catch (error) {
			// Error response
			// eslint-disable-next-line @typescript-eslint/no-unsafe-argument
			return ResponseHelper.sendErrorResponse(res, error);
		}
	},
);

function getUri(options: OAuth2Parameters, tokenType: string) {
	if (!options.clientId || !options.authorizationUri) {
		return Error('Options incomplete, expecting clientId and authorizationUri');
	}
	const qs = {
		client_id: options.clientId,
		redirect_uri: options.redirectUri,
		response_type: tokenType,
		state: options.state,
	};

	if (options.scopes !== undefined) {
		Object.assign(qs, { scope: options.scopes.join(' ') });
	}

	const sep = options.authorizationUri.includes('?') ? '&' : '?';
	return options.authorizationUri + sep + querystring.stringify(Object.assign(qs, options.query));
}

function getToken(uri: string, incOptions: Object, oAuth2Parameters: OAuth2Parameters) {
	let self = oAuth2Parameters;
	let options = Object.assign({}, this.client.options, incOptions);

	let url = new URL(uri);

	if (
		typeof options.redirectUri === 'string' &&
		typeof url.pathname === 'string' &&
		url.pathname !== new URL(options.redirectUri, DEFAULT_URL_BASE).pathname
	) {
		return Promise.reject(
			new TypeError('Redirected path should match configured path, but got: ' + url.pathname),
		);
	}

	if (!url.search || !url.search.substr(1)) {
		return Promise.reject(new TypeError('Unable to process uri: ' + uri));
	}

	var data =
		typeof url.search === 'string' ? querystring.parse(url.search.substr(1)) : url.search || {};
	var err = getAuthError(data);

	if (err) {
		return Promise.reject(err);
	}

	if (options.state != null && data.state !== options.state) {
		return Promise.reject(new TypeError('Invalid state: ' + data.state));
	}

	// Check whether the response code is set.
	if (!data.code) {
		return Promise.reject(new TypeError('Missing code, unable to request token'));
	}

	var headers = Object.assign({}, DEFAULT_HEADERS);
	var body = {
		code: data.code,
		grant_type: 'authorization_code',
		redirect_uri: options.redirectUri,
	};

	// `client_id`: REQUIRED, if the client is not authenticating with the
	// authorization server as described in Section 3.2.1.
	// Reference: https://tools.ietf.org/html/rfc6749#section-3.2.1
	if (options.clientSecret) {
		headers.Authorization = auth(options.clientId, options.clientSecret);
	} else {
		body.client_id = options.clientId;
	}

	return this.client
		._request(
			requestOptions(
				{
					url: options.accessTokenUri,
					method: 'POST',
					headers: headers,
					body: body,
				},
				options,
			),
		)
		.then(function (data) {
			return self.client.createToken(data);
		});
}
