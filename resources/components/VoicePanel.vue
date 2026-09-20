<template>
	<!-- eslint-disable vue/component-name-in-template-casing -- MediaWiki 1.43 parses templates as HTML; preserve component names with kebab-case. -->
	<div
		class="wandavoice-panel"
		:class="{
			'wandavoice-panel--recording': state === 'capture',
			'wandavoice-panel--processing': state === 'processing'
		}"
	>
		<div
			v-if="isCardVisible"
			id="wandavoice-status-card"
			class="wandavoice-status-card"
		>
			<div class="wandavoice-status-header">
				<strong>{{ msg( 'wandavoice-panel-title' ) }}</strong>
				<cdx-button
					weight="quiet"
					:aria-label="msg( 'wandavoice-close' )"
					@click="closePanel"
				>
					✕
				</cdx-button>
			</div>

			<div class="wandavoice-status-row">
				<span
					class="wandavoice-status-dot"
					:class="'wandavoice-status-dot--' + state"
					aria-hidden="true"
				></span>
				<span class="wandavoice-status-text">{{ statusText }}</span>
			</div>

			<cdx-progress-bar
				v-if="state === 'processing'"
				inline
				:aria-label="msg( 'wandavoice-status-processing' )"
			></cdx-progress-bar>

			<p v-if="transcript" class="wandavoice-transcript">
				<span class="wandavoice-transcript-label">
					{{ msg( 'wandavoice-transcript-label' ) }}
				</span>
				{{ transcript }}
			</p>

			<cdx-message
				v-if="error"
				type="error"
				inline
			>
				{{ error }}
			</cdx-message>

			<p v-else-if="feedback" class="wandavoice-feedback">
				{{ feedback }}
			</p>

			<div v-if="showThinking && thinkingSteps.length" class="wandavoice-thinking">
				<strong>{{ msg( 'wandavoice-thinking-title' ) }}</strong>
				<ol>
					<li v-for="( step, index ) in thinkingSteps" :key="index">
						{{ step }}
					</li>
				</ol>
			</div>

			<div v-if="helpVisible" class="wandavoice-help">
				<strong>{{ msg( 'wandavoice-help-title' ) }}</strong>
				<p>{{ msg( 'wandavoice-help-commands' ) }}</p>
			</div>

			<div class="wandavoice-actions">
				<cdx-button
					v-if="state === 'wake'"
					@click="pushToTalk"
				>
					{{ msg( 'wandavoice-capture-button' ) }}
				</cdx-button>
				<cdx-button
					weight="quiet"
					:aria-expanded="helpVisible"
					@click="helpVisible = !helpVisible"
				>
					{{ msg( 'wandavoice-help-button' ) }}
				</cdx-button>
			</div>
		</div>

		<div class="wandavoice-toolbar">
			<button
				ref="micButton"
				class="wandavoice-mic-button"
				:class="'wandavoice-mic-button--' + state"
				type="button"
				accesskey="v"
				:disabled="unsupported"
				:aria-label="micAriaLabel"
				:aria-pressed="state !== 'off' ? 'true' : 'false'"
				:title="micAriaLabel"
				@click="onMicClick"
			>
				<svg
					class="wandavoice-mic-icon"
					viewBox="0 0 24 24"
					width="24"
					height="24"
					aria-hidden="true"
					fill="currentColor"
				>
					<path d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3z" />
					<path
						d="M19 11a7 7 0 0 1-14 0H3a9 9 0 0 0 8 8.94V23h2v-3.06A9 9 0 0 0 21 11z"
					/>
				</svg>
			</button>
		</div>

		<!-- Screen reader announcements of every state change and confirmation. -->
		<div
			class="wandavoice-sr-live"
			aria-live="polite"
			role="status"
		>
			{{ liveAnnouncement }}
		</div>
	</div>
</template>

<script>
const { CdxButton, CdxProgressBar, CdxMessage } = require( '../../codex.js' );

// @vue/component
module.exports = exports = {
	name: 'VoicePanel',
	components: {
		CdxButton,
		CdxProgressBar,
		CdxMessage
	},
	props: {
		showThinking: {
			type: Boolean,
			default: false
		},
		visualIndicators: {
			type: Boolean
		},
		unsupported: {
			type: Boolean,
			default: false
		},
		wakePhrase: {
			type: String,
			default: ''
		},
		onToggleListening: {
			type: Function,
			default: null
		},
		onPushToTalk: {
			type: Function,
			default: null
		}
	},
	emits: [ 'toggle-listening', 'push-to-talk' ],
	data() {
		return {
			state: 'off',
			expanded: false,
			transcript: '',
			feedback: '',
			error: '',
			thinkingSteps: [],
			helpVisible: false,
			liveAnnouncement: ''
		};
	},
	computed: {
		isCardVisible() {
			return this.visualIndicators && this.expanded;
		},
		statusText() {
			if ( this.unsupported ) {
				return this.msg( 'wandavoice-status-unsupported' );
			}
			if ( this.state === 'wake' ) {
				return this.msg( 'wandavoice-status-wake', this.wakePhrase );
			}
			if ( this.state === 'capture' ) {
				return this.msg( 'wandavoice-status-listening' );
			}
			if ( this.state === 'processing' ) {
				return this.msg( 'wandavoice-status-processing' );
			}
			if ( this.state === 'dictation' ) {
				return this.msg( 'wandavoice-status-dictation' );
			}
			return this.msg( 'wandavoice-status-idle' );
		},
		micAriaLabel() {
			if ( this.unsupported ) {
				return this.msg( 'wandavoice-error-nosupport' );
			}
			return this.state === 'off' ?
				this.msg( 'wandavoice-button-aria-start' ) :
				this.msg( 'wandavoice-button-aria-stop' );
		}
	},
	/* eslint-disable vue/no-unused-properties */
	methods: {
		/* eslint-disable mediawiki/msg-doc */
		msg( key, ...params ) {
			if ( typeof this.$i18n === 'function' ) {
				const res = this.$i18n( key, ...params );
				if ( res && typeof res.text === 'function' ) {
					return res.text();
				}
				if ( typeof res === 'string' ) {
					return res;
				}
			}
			if ( typeof mw !== 'undefined' && mw.message ) {
				return mw.message( key, ...params ).text();
			}
			return key;
		},
		/* eslint-enable mediawiki/msg-doc */
		onMicClick() {
			if ( this.state === 'off' ) {
				this.error = '';
				this.feedback = '';
				this.transcript = '';
				this.expanded = true;
			}
			if ( typeof this.onToggleListening === 'function' ) {
				this.onToggleListening();
			} else {
				this.$emit( 'toggle-listening' );
			}
		},
		pushToTalk() {
			if ( typeof this.onPushToTalk === 'function' ) {
				this.onPushToTalk();
			} else {
				this.$emit( 'push-to-talk' );
			}
		},
		closePanel() {
			this.expanded = false;
			this.$nextTick( () => {
				if ( this.$refs.micButton ) {
					this.$refs.micButton.focus();
				}
			} );
		},
		setState( state ) {
			const wasOff = this.state === 'off';
			this.state = state;
			if ( wasOff && state !== 'off' ) {
				this.expanded = true;
			}
			this.announce( this.statusText );
		},
		setTranscript( text ) {
			this.transcript = text;
		},
		setThinking( steps ) {
			this.thinkingSteps = steps || [];
		},
		setFeedback( text ) {
			this.error = '';
			this.feedback = text;
			this.announce( text );
		},
		setError( text ) {
			this.feedback = '';
			this.error = text;
			this.expanded = true;
			this.announce( text );
		},
		announce( text ) {
			this.liveAnnouncement = '';
			this.$nextTick( () => {
				this.liveAnnouncement = text;
			} );
		}
	}
	/* eslint-enable vue/no-unused-properties */
};
</script>
