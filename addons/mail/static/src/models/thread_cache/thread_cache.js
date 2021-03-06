odoo.define('mail/static/src/models/thread_cache/thread_cache.js', function (require) {
'use strict';

const { registerNewModel } = require('mail/static/src/model/model_core.js');
const { attr, many2many, many2one, one2many } = require('mail/static/src/model/model_field.js');

function factory(dependencies) {

    class ThreadCache extends dependencies['mail.model'] {

        //----------------------------------------------------------------------
        // Public
        //----------------------------------------------------------------------

        /**
         * @returns {mail.message[]|undefined}
         */
        async loadMoreMessages() {
            if (this.isAllHistoryLoaded || this.isLoading) {
                return;
            }
            if (!this.isLoaded) {
                this.update({ hasToLoadMessages: true });
                return;
            }
            this.update({ isLoadingMore: true });
            const messageIds = this.fetchedMessages.map(message => message.id);
            const limit = 30;
            const fetchedMessages = await this.async(() => this._loadMessages({
                extraDomain: [['id', '<', Math.min(...messageIds)]],
                limit,
            }));
            for (const threadView of this.threadViews) {
                threadView.addComponentHint('more-messages-loaded');
            }
            this.update({ isLoadingMore: false });
            if (fetchedMessages.length < limit) {
                this.update({ isAllHistoryLoaded: true });
            }
            return fetchedMessages;
        }

        /**
         * @returns {mail.message[]|undefined}
         */
        async loadNewMessages() {
            if (this.isLoading) {
                return;
            }
            if (!this.isLoaded) {
                this.update({ hasToLoadMessages: true });
                return;
            }
            const messageIds = this.fetchedMessages.map(message => message.id);
            return this._loadMessages({
                extraDomain: [['id', '>', Math.max(...messageIds)]],
                limit: false,
            });
        }

        //----------------------------------------------------------------------
        // Private
        //----------------------------------------------------------------------

        /**
         * @override
         */
        static _createRecordLocalId(data) {
            const {
                stringifiedDomain = '[]',
                thread: [[commandInsert, thread]],
            } = data;
            return `${this.modelName}_[${thread.localId}]_<${stringifiedDomain}>`;
        }

        /**
         * @private
         */
        _computeCheckedMessages() {
            const messagesWithoutCheckbox = this.checkedMessages.filter(
                message => !message.hasCheckbox
            );
            return [['unlink', messagesWithoutCheckbox]];
        }

        /**
         * @private
         * @returns {mail.message[]}
         */
        _computeFetchedMessages() {
            if (!this.thread) {
                return [['unlink-all']];
            }
            const toUnlinkMessages = [];
            for (const message of this.fetchedMessages) {
                if (!this.thread.messages.includes(message)) {
                    toUnlinkMessages.push(message);
                }
            }
            return [['unlink', toUnlinkMessages]];
        }

        /**
         * @private
         * @returns {mail.message|undefined}
         */
        _computeLastFetchedMessage() {
            const {
                length: l,
                [l - 1]: lastFetchedMessage,
            } = this.orderedFetchedMessages;
            if (!lastFetchedMessage) {
                return [['unlink']];
            }
            return [['link', lastFetchedMessage]];
        }

        /**
         * @private
         * @returns {mail.message|undefined}
         */
        _computeLastMessage() {
            const {
                length: l,
                [l - 1]: lastMessage,
            } = this.orderedMessages;
            if (!lastMessage) {
                return [['unlink']];
            }
            return [['link', lastMessage]];
        }

        /**
         * @private
         * @returns {mail.message[]}
         */
        _computeMessages() {
            if (!this.thread) {
                return [['unlink-all']];
            }
            let messages = this.fetchedMessages;
            if (this.stringifiedDomain !== '[]') {
                // AKU TODO: flag for invalidation if there are newer messages
                // in thread. task-2171873
                return [['replace', messages]];
            }
            // main cache: adjust with newer messages
            let newerMessages;
            if (!this.lastFetchedMessage) {
                newerMessages = this.thread.messages;
            } else {
                newerMessages = this.thread.messages.filter(message =>
                    message.id > this.lastFetchedMessage.id
                );
            }
            messages = messages.concat(newerMessages);
            return [['replace', messages]];
        }

        /**
         * @private
         * @returns {mail.message[]}
         */
        _computeOrderedFetchedMessages() {
            return [['replace', this.fetchedMessages.sort((m1, m2) => m1.id < m2.id ? -1 : 1)]];
        }

        /**
         * @private
         * @returns {mail.message[]}
         */
        _computeOrderedMessages() {
            return [['replace', this.messages.sort((m1, m2) => m1.id < m2.id ? -1 : 1)]];
        }

        /**
         * @private
         * @returns {boolean}
         */
        _computeHasToLoadMessages() {
            return (
                this.thread &&
                !this.thread.isTemporary &&
                this.threadViews.length > 0 &&
                !this.isLoaded &&
                !this.isLoading
            );
        }

        /**
         * @private
         * @returns {mail.message[]}
         */
        _computeUncheckedMessages() {
            return [['replace', this.messages.filter(
                message => message.hasCheckbox && !this.checkedMessages.includes(message)
            )]];
        }

        /**
         * @private
         * @param {Array} domain
         * @returns {Array}
         */
        _extendMessageDomain(domain) {
            const thread = this.thread;
            if (thread.model === 'mail.channel') {
                return domain.concat([['channel_ids', 'in', [thread.id]]]);
            } else if (thread === this.env.messaging.inbox) {
                return domain.concat([['needaction', '=', true]]);
            } else if (thread === this.env.messaging.starred) {
                return domain.concat([
                    ['starred_partner_ids', 'in', [this.env.messaging.currentPartner.id]],
                ]);
            } else if (thread === this.env.messaging.history) {
                return domain.concat([['needaction', '=', false]]);
            } else if (thread === this.env.messaging.moderation) {
                return domain.concat([['moderation_status', '=', 'pending_moderation']]);
            } else {
                // Avoid to load user_notification as these messages are not
                // meant to be shown on chatters.
                return domain.concat([
                    ['message_type', '!=', 'user_notification'],
                    ['model', '=', thread.model],
                    ['res_id', '=', thread.id],
                ]);
            }
        }

        /**
         * @private
         * @param {Object} [param0={}]
         * @param {Array[]} [param0.extraDomain]
         * @param {integer} [param0.limit=30]
         * @returns {mail.message[]}
         */
        async _loadMessages({ extraDomain, limit = 30 } = {}) {
            this.update({ isLoading: true });
            const searchDomain = JSON.parse(this.stringifiedDomain);
            let domain = searchDomain.length ? searchDomain : [];
            domain = this._extendMessageDomain(domain);
            if (extraDomain) {
                domain = extraDomain.concat(domain);
            }
            const context = this.env.session.user_context;
            const moderated_channel_ids = this.thread.moderation
                ? [this.thread.id]
                : undefined;
            const messages = await this.async(() =>
                this.env.models['mail.message'].performRpcMessageFetch(
                    domain,
                    limit,
                    moderated_channel_ids,
                    context,
                )
            );
            this.update({
                fetchedMessages: [['link', messages]],
                isLoaded: true,
                isLoading: false,
            });
            if (!extraDomain && messages.length < limit) {
                this.update({ isAllHistoryLoaded: true });
            }
            this.env.messagingBus.trigger('o-thread-cache-loaded-messages', {
                fetchedMessages: messages,
                threadCache: this,
            });
            return messages;
        }

        /**
         * Loads this thread cache, by fetching the most recent messages in this
         * conversation.
         *
         * @private
         */
        _onHasToLoadMessagesChanged() {
            if (!this.hasToLoadMessages) {
                return;
            }
            this._loadMessages();
        }

    }

    ThreadCache.fields = {
        checkedMessages: many2many('mail.message', {
            compute: '_computeCheckedMessages',
            dependencies: [
                'checkedMessages',
                'messagesCheckboxes',
            ],
            inverse: 'checkedThreadCaches',
        }),
        /**
         * List of messages that have been fetched by this cache.
         *
         * This DOES NOT necessarily includes all messages linked to this thread
         * cache (@see messages field for that): it just contains list
         * of successive messages that have been explicitly fetched by this
         * cache. For all non-main caches, this corresponds to all messages.
         * For the main cache, however, messages received from longpolling
         * should be displayed on main cache but they have not been explicitly
         * fetched by cache, so they ARE NOT in this list (at least, not until a
         * fetch on this thread cache contains this message).
         *
         * The distinction between messages and fetched messages is important
         * to manage "holes" in message list, while still allowing to display
         * new messages on main cache of thread in real-time.
         */
        fetchedMessages: many2many('mail.message', {
            // adjust with messages unlinked from thread
            compute: '_computeFetchedMessages',
            dependencies: ['threadMessages'],
        }),
        /**
         * Determines whether `this` should load initial messages.
         */
        hasToLoadMessages: attr({
            compute: '_computeHasToLoadMessages',
            dependencies: [
                'isLoaded',
                'isLoading',
                'thread',
                'threadIsTemporary',
                'threadViews',
            ],
        }),
        isAllHistoryLoaded: attr({
            default: false,
        }),
        isLoaded: attr({
            default: false,
        }),
        isLoading: attr({
            default: false,
        }),
        isLoadingMore: attr({
            default: false,
        }),
        /**
         * Last message that has been fetched by this thread cache.
         *
         * This DOES NOT necessarily mean the last message linked to this thread
         * cache (@see lastMessage field for that). @see fetchedMessages field
         * for a deeper explanation about "fetched" messages.
         */
        lastFetchedMessage: many2one('mail.message', {
            compute: '_computeLastFetchedMessage',
            dependencies: ['orderedFetchedMessages'],
        }),
        lastMessage: many2one('mail.message', {
            compute: '_computeLastMessage',
            dependencies: ['orderedMessages'],
        }),
        messagesCheckboxes: attr({
            related: 'messages.hasCheckbox',
        }),
        /**
         * List of messages linked to this cache.
         */
        messages: many2many('mail.message', {
            compute: '_computeMessages',
            dependencies: [
                'fetchedMessages',
                'threadMessages',
            ],
        }),
        /**
         * Loads initial messages from `this`.
         * This is not a "real" field, its compute function is used to trigger
         * the load of messages at the right time.
         */
        onHasToLoadMessagesChanged: attr({
            compute: '_onHasToLoadMessagesChanged',
            dependencies: [
                'hasToLoadMessages',
            ],
        }),
        /**
         * Ordered list of messages that have been fetched by this cache.
         *
         * This DOES NOT necessarily includes all messages linked to this thread
         * cache (@see orderedMessages field for that). @see fetchedMessages
         * field for deeper explanation about "fetched" messages.
         */
        orderedFetchedMessages: many2many('mail.message', {
            compute: '_computeOrderedFetchedMessages',
            dependencies: ['fetchedMessages'],
        }),
        /**
         * Ordered list of messages linked to this cache.
         */
        orderedMessages: many2many('mail.message', {
            compute: '_computeOrderedMessages',
            dependencies: ['messages'],
        }),
        stringifiedDomain: attr({
            default: '[]',
        }),
        thread: many2one('mail.thread', {
            inverse: 'caches',
        }),
        /**
         * Serves as compute dependency.
         */
        threadIsTemporary: attr({
            related: 'thread.isTemporary',
        }),
        threadMessages: many2many('mail.message', {
            related: 'thread.messages',
        }),
        /**
         * States the 'mail.thread_view' that are currently displaying `this`.
         */
        threadViews: one2many('mail.thread_view', {
            inverse: 'threadCache',
        }),
        uncheckedMessages: many2many('mail.message', {
            compute: '_computeUncheckedMessages',
            dependencies: [
                'checkedMessages',
                'messagesCheckboxes',
                'messages',
            ],
        }),
    };

    ThreadCache.modelName = 'mail.thread_cache';

    return ThreadCache;
}

registerNewModel('mail.thread_cache', factory);

});
