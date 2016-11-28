const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;
const Pango = imports.gi.Pango;
const Tp = imports.gi.TelepathyGLib;

const AccountsMonitor = imports.accountsMonitor;
const Lang = imports.lang;
const Mainloop = imports.mainloop;
const RoomManager = imports.roomManager;
const Signals = imports.signals;

let _singleton = null;

function getDefault() {
    if (_singleton == null)
        _singleton = new _ServerRoomManager();
    return _singleton;
}

const _ServerRoomManager = new Lang.Class({
    Name: '_ServerRoomManager',

    _init: function() {
        this._roomLists = new Map();

        this._accountsMonitor = AccountsMonitor.getDefault();
        this._accountsMonitor.connect('account-status-changed',
                                      Lang.bind(this, this._onAccountStatusChanged));
        this._accountsMonitor.connect('account-removed',
                                      Lang.bind(this, this._onAccountRemoved));
        this._accountsMonitor.prepare(() => {
            this._accountsMonitor.enabledAccounts.forEach(a => {
                this._onAccountStatusChanged(this._accountsMonitor, a);
            });
        });
    },

    getRoomInfos: function(account) {
        let roomList = this._roomLists.get(account);
        if (!roomList || roomList.list.listing)
            return [];
        return roomList.rooms.slice();
    },

    isLoading: function(account) {
        let roomList = this._roomLists.get(account);
        if (!roomList)
            return false;
        return roomList.list.listing;
    },

    _onAccountStatusChanged: function(mon, account) {
        if (account.connection_status != Tp.ConnectionStatus.CONNECTED)
            return;

        if (this._roomLists.has(account))
            return;

        let roomList = new Tp.RoomList({ account: account });
        roomList.init_async(GLib.PRIORITY_DEFAULT, null, (o, res) => {
            roomList.init_finish(res);
            roomList.start();
        });
        roomList.connect('got-room', Lang.bind(this, this._onGotRoom));
        roomList.connect('notify::listing',
                         Lang.bind(this, this._onListingChanged));
        this._roomLists.set(account, { list: roomList, rooms: [] });
    },

    _onAccountRemoved: function(mon, account) {
        let roomList = this._roomLists.get(account);
        if (!roomList)
            return;

        roomList.list.run_dispose();
        this._roomLists.delete(account);
    },

    _onGotRoom: function(list, roomInfo) {
        let roomList = this._roomLists.get(list.account);
        if (!roomList)
            return;

        debug('Got room %s for account %s'.format(roomInfo.get_name(),
                                                  list.account.display_name));
        roomList.rooms.push(roomInfo);
    },

    _onListingChanged: function(list) {
        if (!list.listing)
            this.emit('loaded', list.account);
    }
});
Signals.addSignalMethods(_ServerRoomManager.prototype);


const RoomListColumn = {
    CHECKED:   0,
    NAME:      1,
    COUNT:     2,

    SENSITIVE: 3,
};

const ServerRoomList = new Lang.Class({
    Name: 'ServerRoomList',
    Extends: Gtk.ScrolledWindow,
    Properties: { 'can-join': GObject.ParamSpec.boolean('can-join',
                                                        'can-join',
                                                        'can-join',
                                                        GObject.ParamFlags.READABLE,
                                                        false),
                  'loading': GObject.ParamSpec.boolean('loading',
                                                       'loading',
                                                       'loading',
                                                       GObject.ParamFlags.READABLE,
                                                       false)
    },

    _init: function(params) {
        this._account = null;
        this._pendingInfos = [];

        this.parent(params);

        this.connect('destroy', () => {
            this.setAccount(null);
        });

        let store = new Gtk.ListStore();
        store.set_column_types([GObject.TYPE_BOOLEAN,
                                GObject.TYPE_STRING,
                                GObject.TYPE_STRING,
                                GObject.TYPE_BOOLEAN]);

        this._list = new Gtk.TreeView({ model: store,
                                        activate_on_single_click: true,
                                        enable_grid_lines: Gtk.TreeViewGridLines.HORIZONTAL,
                                        headers_visible: false,
                                        visible: true });
        this._list.get_style_context().add_class('polari-server-room-list');
        this._list.connect('row-activated', (view, path, column) => {
            this._toggleChecked(path);
        });
        this.add(this._list);

        let renderer;

        let column = new Gtk.TreeViewColumn();
        this._list.append_column(column);

        renderer = new Gtk.CellRendererToggle();
        renderer.connect('toggled', (cell, pathStr) => {
            this._toggleChecked(Gtk.TreePath.new_from_string(pathString));
        });

        column.pack_start(renderer, false);
        column.add_attribute(renderer, 'active', RoomListColumn.CHECKED);
        column.add_attribute(renderer, 'sensitive', RoomListColumn.SENSITIVE);

        renderer = new Gtk.CellRendererText({ ellipsize: Pango.EllipsizeMode.END });

        column.pack_start(renderer, true);
        column.add_attribute(renderer, 'text', RoomListColumn.NAME);
        column.add_attribute(renderer, 'sensitive', RoomListColumn.SENSITIVE);

        renderer = new Gtk.CellRendererText();

        column.pack_start(renderer, false);
        column.add_attribute(renderer, 'text', RoomListColumn.COUNT);
        column.add_attribute(renderer, 'sensitive', RoomListColumn.SENSITIVE);

        this._manager = getDefault();
        this._manager.connect('loaded', Lang.bind(this, this._onLoaded));
    },

    get can_join() {
        let canJoin = false;
        this._list.model.foreach((model, path, iter) => {
            canJoin = model.get_value(iter, RoomListColumn.SENSITIVE) &&
                      model.get_value(iter, RoomListColumn.CHECKED);
            return canJoin;
        });
        return canJoin;
    },

    get loading() {
        return this._pendingInfos.length ||
               this._manager.isLoading(this._account);
    },

    get selectedRooms() {
        let rooms = [];
        let [valid, iter] = this._list.model.get_iter_first();
        for (; valid; valid = this._list.model.iter_next(iter)) {
            if (!this._list.model.get_value(iter, RoomListColumn.SENSITIVE) ||
                !this._list.model.get_value(iter, RoomListColumn.CHECKED))
                continue;
            rooms.push(this._list.model.get_value(iter, RoomListColumn.NAME));
        }
        return rooms;
    },

    setAccount: function(account) {
        if (this._account == account)
            return;

        this._account = account;
        this._onLoaded(this._manager, account);
    },

    _onLoaded: function(mgr, account) {
        if (account != this._account)
            return;

        this._list.model.clear();

        if (this._timeoutId)
            Mainloop.source_remove(this._timeoutId);

        let roomInfos = this._manager.getRoomInfos(account);
        roomInfos.sort((info1, info2) => {
            let count1 = info1.get_members_count(null);
            let count2 = info2.get_members_count(null);
            if (count1 != count2)
                return count2 - count1;
            return info1.get_name().localeCompare(info2.get_name());
        });
        this._pendingInfos = roomInfos;

        this.notify('loading');

        let roomManager = RoomManager.getDefault();

        this._timeoutId = Mainloop.timeout_add(500, () => {
            this._pendingInfos.splice(0, 50).forEach(roomInfo => {
                let store = this._list.model;

                let name = roomInfo.get_name();
                if (name[0] == '#')
                    name = name.substr(1, name.length);

                let room = roomManager.lookupRoomByName(roomInfo.get_name());
                let sensitive = room == null;
                let checked = !sensitive;
                let count = '%d'.format(roomInfo.get_members_count(null));

                store.insert_with_valuesv(-1,
                                          [RoomListColumn.CHECKED,
                                           RoomListColumn.NAME,
                                           RoomListColumn.COUNT,
                                           RoomListColumn.SENSITIVE],
                                          [checked, name, count, sensitive]);

                //row.connect('notify::checked', () => { this.notify('can-join'); });
            });
            if (this._pendingInfos.length)
                return GLib.SOURCE_CONTINUE;

            this._timeoutId = 0;
            this.notify('loading');
            return GLib.SOURCE_REMOVE;
        });
    },

    _toggleChecked: function(path) {
        let [valid, iter] = this._list.model.get_iter(path);
        if (!this._list.model.get_value(iter, RoomListColumn.SENSITIVE))
            return;
        let checked = this._list.model.get_value(iter, RoomListColumn.CHECKED);
        this._list.model.set_value(iter, RoomListColumn.CHECKED, !checked);

        this.notify('can-join');
    }
});

const ServerRoomRow = new Lang.Class({
    Name: 'ServerRoomRow',
    Extends: Gtk.ListBoxRow,
    Properties: { 'checked': GObject.ParamSpec.boolean('checked',
                                                       'checked',
                                                       'checked',
                                                       GObject.ParamFlags.READABLE,
                                                       false),
    },

    _init: function(params) {
        if (!params || !params.info)
            throw new Error('No info in parameters');

        this._info = params.info;
        delete params.info;

        this.parent(params);

        let room = RoomManager.getDefault().lookupRoomByName(this._info.get_name());
        this.sensitive = !room;

        let name = this._info.get_name();
        if (name[0] == '#')
           name = name.substr(1, name.length);

        let box = new Gtk.Box({ spacing: 12, margin: 12 });
        this.add(box);

        this._checkbox = new Gtk.CheckButton({ active: !this.sensitive });
        this._checkbox.connect('toggled', Lang.bind(this,
            function() {
                this.notify('checked');
            }));

        box.add(this._checkbox);

        box.add(new Gtk.Label({ label: name,
                                hexpand: true,
                                halign: Gtk.Align.START }));

        let count = this._info.get_members_count(null);
        let label = new Gtk.Label({ label: "%d".format(count) });
        label.get_style_context().add_class('dim-label');
        box.add(label);

        this.show_all();
    },

    get info() {
        return this._info;
    },

    get checked() {
        return this._checkbox.active;
    }
});
