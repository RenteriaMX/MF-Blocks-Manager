/**
 * MF Blocks Control Panel
 * Manages Module Federation blocks from Site Setup.
 */
import React, { useEffect, useState, useCallback, useRef } from 'react';
import { Helmet } from '@plone/volto/helpers';
import {
  Container, Table, Button, Header, Segment, Label, Icon,
  Confirm, Modal, Form, Message, Divider,
} from 'semantic-ui-react';
import { useDispatch } from 'react-redux';
import { Link, useLocation } from 'react-router-dom';
import { createPortal } from 'react-dom';
import { defineMessages, useIntl } from 'react-intl';
import { useClient } from '@plone/volto/hooks/client/useClient';
import VIcon from '@plone/volto/components/theme/Icon/Icon';
import Toolbar from '@plone/volto/components/manage/Toolbar/Toolbar';
import backSVG from '@plone/volto/icons/back.svg';
import { getMFBlocks, manageMFBlock, createMFBlock } from '../../actions';
import checkSVG from '@plone/volto/icons/check.svg';
import circleDismissSVG from '@plone/volto/icons/circle-dismiss.svg';

interface MFBlockEntry {
  uid: string;
  title: string;
  block_id: string;
  remote_name: string;
  version: string;
  group: string;
  active: boolean;
  review_state: string;
  url: string;
  path: string;
  created: string;
  modified: string;
}

const messages = defineMessages({
  back: { id: 'Back', defaultMessage: 'Back' },
});

const stateColors: Record<string, string> = {
  published: 'green',
  private: 'red',
  pending: 'yellow',
};

const stateLabels: Record<string, string> = {
  published: 'Published',
  private: 'Draft',
  pending: 'Pending',
};

const groupOptions = [
  { key: 'bricks', value: 'bricks', text: 'Bricks' },
  { key: 'common', value: 'common', text: 'Common' },
  { key: 'text', value: 'text', text: 'Text' },
  { key: 'media', value: 'media', text: 'Media' },
  { key: 'mostUsed', value: 'mostUsed', text: 'Most Used' },
];

// --- Lectura del bundle en el navegador (autollenado del formulario) ----------
// Al elegir el .tar.gz lo descomprimimos y leemos el contrato del bloque para
// rellenar los campos solos. La FUENTE DE VERDAD del remote_name es el BUNDLE
// (igual que el backend): asi el operador no teclea nada y nunca hay un mismatch
// de mayus/minus que dispare "Remote container not found" al insertar el bloque.
// El backend re-detecta de todas formas; esto es la red de seguridad VISIBLE
// (ves el name detectado antes de pulsar Install, o vacio si el bundle esta mal).
const CONTAINER_NAME_RE = /volto[A-Za-z0-9]+Block/;       // mismo patron que el backend
const EXPOSED_MODULE_RE = /"(\.\/[^"]+)":\(\)=>/;         // modulo expuesto en remoteEntry.js
const VERSION_FROM_FILENAME_RE = /-(\d+\.\d+\.\d+[a-zA-Z0-9._-]*)\.tar\.gz$/;
// id/title/group que declara el PROPIO bloque (su @type real). Exigimos group para
// descartar la variacion {id:"default",title:"Default"} que no lo trae.
// Exigimos `group:` en la regex SOLO para descartar la variacion
// {id:"default",title:"Default"} (que no lo trae); el group NO se autollena
// -> el form se queda en su default (Bricks) y lo decide el operador.
const BLOCK_CONFIG_RE = /id:"([^"]+)",title:"([^"]+)"[^}]*?group:"[^"]+"/;

interface BundleInfo {
  remote_name?: string;
  remote_module?: string;
  version?: string;
  block_id?: string;
  title?: string;
}

// gzip nativo del navegador (sin dependencias). null si el browser no lo soporta
// (Chrome 80+/Firefox 113+/Safari 16.4+); ahi se cae al llenado manual.
async function gunzip(buf: ArrayBuffer): Promise<Uint8Array | null> {
  const DS = (globalThis as any).DecompressionStream;
  if (typeof DS === 'undefined') return null;
  const stream = new Blob([buf]).stream().pipeThrough(new DS('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// Parser tar minimo: headers de 512 bytes, nombre@0 (100b), tamano@124 (octal).
function parseTar(bytes: Uint8Array): Record<string, Uint8Array> {
  const files: Record<string, Uint8Array> = {};
  const dec = new TextDecoder();
  let off = 0;
  while (off + 512 <= bytes.length) {
    const name = dec.decode(bytes.subarray(off, off + 100)).replace(/\0.*$/, '');
    if (!name) break; // bloque cero = fin del archivo
    const sizeStr = dec.decode(bytes.subarray(off + 124, off + 136)).replace(/[^0-7]/g, '');
    const size = parseInt(sizeStr || '0', 8) || 0;
    const start = off + 512;
    files[name.replace(/^\.\//, '')] = bytes.subarray(start, start + size);
    off = start + Math.ceil(size / 512) * 512; // datos padeados al multiplo de 512
  }
  return files;
}

// Lee el contrato del bloque del .tar.gz. Mismo orden que el backend:
// mf-manifest.json > regex sobre remoteEntry.js. Devuelve solo lo detectado.
async function readBundleInfo(file: File): Promise<BundleInfo | null> {
  let tarBytes: Uint8Array | null;
  try {
    tarBytes = await gunzip(await file.arrayBuffer());
  } catch {
    return null;
  }
  if (!tarBytes) return null; // navegador sin DecompressionStream -> manual
  const files = parseTar(tarBytes);
  const dec = new TextDecoder();
  const info: BundleInfo = {};

  // 1) mf-manifest.json (contrato explicito), si el bundle lo trae
  const manifestKey = Object.keys(files).find(
    (k) => k === 'mf-manifest.json' || k.endsWith('/mf-manifest.json'),
  );
  if (manifestKey) {
    try {
      const m = JSON.parse(dec.decode(files[manifestKey]));
      if (typeof m.name === 'string') info.remote_name = m.name;
      if (typeof m.module === 'string') info.remote_module = m.module;
      if (typeof m.version === 'string') info.version = m.version;
    } catch {
      /* manifest ilegible -> caemos al regex */
    }
  }

  // 2) regex sobre remoteEntry.js (fallback para bundles sin manifest)
  if (!info.remote_name || !info.remote_module) {
    const reKey = Object.keys(files).find((k) => k.endsWith('remoteEntry.js'));
    if (reKey) {
      const content = dec.decode(files[reKey]);
      if (!info.remote_name) {
        const m = content.match(CONTAINER_NAME_RE);
        if (m) info.remote_name = m[0];
      }
      if (!info.remote_module) {
        const m = content.match(EXPOSED_MODULE_RE);
        if (m) info.remote_module = m[1];
      }
    }
  }

  // 3) version: del nombre del archivo si el bundle no la declara
  if (!info.version) {
    const m = file.name.match(VERSION_FROM_FILENAME_RE);
    if (m) info.version = m[1];
  }

  // 4) block_id/title: el @type REAL que declara el bloque (NO derivado del
  // name, para no inventar "event-card" cuando el bloque es "eventCard").
  // El group NO se toma del bundle: se deja el default del form (Bricks).
  for (const k of Object.keys(files)) {
    if (!k.endsWith('.js') || k.endsWith('remoteEntry.js')) continue;
    const m = dec.decode(files[k]).match(BLOCK_CONFIG_RE);
    if (m && m[1] !== 'default') {
      info.block_id = m[1];
      info.title = m[2];
      break;
    }
  }

  return info;
}

const MFBlocksControlPanel: React.FC = () => {
  const [blocks, setBlocks] = useState<MFBlockEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  // Install modal state
  const [showInstall, setShowInstall] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [formData, setFormData] = useState({
    title: '',
    block_id: '',
    remote_name: '',
    remote_module: './block',
    version: '1.0.0',
    group: 'bricks',
  });
  const [bundleFile, setBundleFile] = useState<File | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Campos que se llenaron AUTO desde el bundle (no se sobreescriben al teclear el
  // titulo) + nota de deteccion mostrada en el modal.
  const [autoFields, setAutoFields] = useState<Record<string, boolean>>({});
  const [detectNote, setDetectNote] = useState('');
  const [detectWarn, setDetectWarn] = useState(false);

  // Update modal state
  const [updateTarget, setUpdateTarget] = useState<MFBlockEntry | null>(null);
  const [updating, setUpdating] = useState(false);
  const [updateVersion, setUpdateVersion] = useState('');
  const [updateFile, setUpdateFile] = useState<File | null>(null);
  const updateFileRef = useRef<HTMLInputElement>(null);

  const intl = useIntl();
  const { pathname } = useLocation();
  const isClient = useClient();

  const dispatch = useDispatch();

  // Mensaje legible de un error del API middleware de Volto
  const apiError = (err: any): string =>
    err?.response?.body?.error ||
    err?.response?.body?.message ||
    err?.message ||
    'Request failed';

  const fetchBlocks = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data: any = await dispatch(getMFBlocks() as any);
      setBlocks(data.blocks || []);
    } catch (err: any) {
      setError(apiError(err));
    } finally {
      setLoading(false);
    }
  }, [dispatch]);

  useEffect(() => {
    fetchBlocks();
  }, [fetchBlocks]);

  const doAction = async (uid: string, action: string) => {
    setActionLoading(uid);
    setError('');
    setSuccess('');
    try {
      const result: any = await dispatch(manageMFBlock({ uid, action }) as any);
      if (action === 'delete') {
        setSuccess(`Block "${result.title}" deleted.`);
      }
      await fetchBlocks();
      if (['publish', 'retract', 'activate', 'deactivate', 'delete'].includes(action)) {
        setTimeout(() => window.location.reload(), 1500);
      }
    } catch (err: any) {
      setError(apiError(err));
    } finally {
      setActionLoading(null);
      setConfirmDelete(null);
    }
  };

  // Deriva block_id/remote_name del titulo SOLO si no vinieron ya del bundle
  // (el bundle manda; teclear el titulo no debe pisar lo auto-detectado).
  const handleTitleChange = (val: string) => {
    setFormData((prev) => {
      const next = { ...prev, title: val };
      if (!autoFields.block_id) {
        next.block_id = val
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-|-$/g, '');
      }
      if (!autoFields.remote_name) {
        next.remote_name = 'volto' + val
          .replace(/[^a-zA-Z0-9 ]/g, '')
          .split(' ')
          .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
          .join('') + 'Block';
      }
      return next;
    });
  };

  // Al elegir el .tar.gz: leerlo y autollenar el formulario desde el bundle.
  const handleBundleSelect = async (file: File | null) => {
    setBundleFile(file);
    setDetectNote('');
    setDetectWarn(false);
    setAutoFields({});
    if (!file) return;
    const info = await readBundleInfo(file);
    if (!info || !info.remote_name) {
      setDetectWarn(true);
      setDetectNote(
        'No se pudo leer el remote_name del bundle en el navegador. ' +
        'Puedes ingresarlo a mano; el servidor lo re-detecta al instalar.',
      );
      return;
    }
    const auto: Record<string, boolean> = {};
    setFormData((prev) => {
      const next = { ...prev };
      if (info.remote_name) { next.remote_name = info.remote_name; auto.remote_name = true; }
      if (info.remote_module) { next.remote_module = info.remote_module; auto.remote_module = true; }
      if (info.version) { next.version = info.version; auto.version = true; }
      if (info.block_id) { next.block_id = info.block_id; auto.block_id = true; }
      if (info.title) { next.title = info.title; auto.title = true; }
      // group: NO se autollena; se respeta el default del form (Bricks).
      return next;
    });
    setAutoFields(auto);
    setDetectNote(`Detectado del bundle: ${info.remote_name}`);
  };

  const fileToBase64 = (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result as string;
        const base64 = result.split(',')[1];
        resolve(base64);
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  };

  const handleInstall = async () => {
    if (!bundleFile) {
      setError('Please select a .tar.gz file');
      return;
    }
    if (!formData.title || !formData.block_id || !formData.remote_name) {
      setError('Please fill in all required fields');
      return;
    }

    setInstalling(true);
    setError('');
    try {
      const base64 = await fileToBase64(bundleFile);

      const result: any = await dispatch(
        createMFBlock({
          ...formData,
          bundle_data: base64,
          bundle_filename: bundleFile.name,
          auto_publish: true,
        }) as any,
      );

      setSuccess(result.message || `Block "${formData.title}" installed.`);
      setShowInstall(false);
      resetForm();
      setTimeout(() => window.location.reload(), 1500);
    } catch (err: any) {
      setError(apiError(err));
    } finally {
      setInstalling(false);
    }
  };

  const handleUpdate = async () => {
    if (!updateTarget || !updateFile) {
      setError('Please select a .tar.gz file');
      return;
    }

    setUpdating(true);
    setError('');
    try {
      const base64 = await fileToBase64(updateFile);

      await dispatch(
        manageMFBlock({
          uid: updateTarget.uid,
          action: 'update',
          bundle_data: base64,
          bundle_filename: updateFile.name,
          version: updateVersion || undefined,
        }) as any,
      );

      setSuccess(`Block "${updateTarget.title}" updated successfully.`);
      closeUpdateModal();
      await fetchBlocks();
      setTimeout(() => window.location.reload(), 1500);
    } catch (err: any) {
      setError(apiError(err));
    } finally {
      setUpdating(false);
    }
  };

  const openUpdateModal = (block: MFBlockEntry) => {
    setUpdateTarget(block);
    setUpdateVersion(block.version);
    setUpdateFile(null);
  };

  const closeUpdateModal = () => {
    setUpdateTarget(null);
    setUpdateVersion('');
    setUpdateFile(null);
    if (updateFileRef.current) updateFileRef.current.value = '';
  };

  const resetForm = () => {
    setFormData({
      title: '',
      block_id: '',
      remote_name: '',
      remote_module: './block',
      version: '1.0.0',
      group: 'bricks',
    });
    setBundleFile(null);
    setAutoFields({});
    setDetectNote('');
    setDetectWarn(false);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  return (
    <Container id="mfblocks-controlpanel" style={{ padding: '2em 0' }}>
      <Helmet title="MF Blocks Manager" />

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5em' }}>
        <div>
          <Header as="h1" style={{ marginBottom: '0.2em' }}>
            Module Federation Blocks
          </Header>
          <p style={{ color: '#666', margin: 0 }}>
            Manage remote blocks loaded via Module Federation.
          </p>
        </div>
        <Button primary icon labelPosition="left" onClick={() => setShowInstall(true)}>
          <Icon name="plus" />
          Install Block
        </Button>
      </div>

      {error && (
        <Message negative onDismiss={() => setError('')}>
          <Message.Header>Error</Message.Header>
          <p>{error}</p>
        </Message>
      )}

      {success && (
        <Message positive onDismiss={() => setSuccess('')}>
          <p>{success}</p>
        </Message>
      )}

      <Segment loading={loading}>
        <Table celled striped>
          <Table.Header>
            <Table.Row>
              <Table.HeaderCell>Block</Table.HeaderCell>
              <Table.HeaderCell>Block ID</Table.HeaderCell>
              <Table.HeaderCell>Version</Table.HeaderCell>
              <Table.HeaderCell>Group</Table.HeaderCell>
              <Table.HeaderCell>State</Table.HeaderCell>
              <Table.HeaderCell>Active</Table.HeaderCell>
              <Table.HeaderCell>Actions</Table.HeaderCell>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {blocks.length === 0 && !loading && (
              <Table.Row>
                <Table.Cell colSpan="7" textAlign="center" style={{ color: '#999', padding: '2em' }}>
                  No MF blocks registered. Use "Install Block" to add one.
                </Table.Cell>
              </Table.Row>
            )}
            {blocks.map((block) => (
              <Table.Row key={block.uid}>
                <Table.Cell>
                  <strong>{block.title}</strong>
                  <br />
                  <small style={{ color: '#888' }}>{block.remote_name}</small>
                </Table.Cell>
                <Table.Cell>
                  <code>{block.block_id}</code>
                </Table.Cell>
                <Table.Cell>{block.version}</Table.Cell>
                <Table.Cell>{block.group}</Table.Cell>
                <Table.Cell>
                  <Label color={stateColors[block.review_state] as any || 'grey'} size="small">
                    {stateLabels[block.review_state] || block.review_state}
                  </Label>
                </Table.Cell>
                <Table.Cell textAlign="center">
                  {block.active ? (
                    <VIcon name={checkSVG} size="20px" color="green" title="Active" />
                  ) : (
                    <VIcon name={circleDismissSVG} size="20px" color="red" title="Inactive" />
                  )}
                </Table.Cell>
                <Table.Cell>
                  <Button.Group size="small">
                    {block.review_state !== 'published' ? (
                      <Button
                        positive
                        icon="check"
                        content="Publish"
                        loading={actionLoading === block.uid}
                        onClick={() => doAction(block.uid, 'publish')}
                      />
                    ) : (
                      <Button
                        icon="hide"
                        content="Retract"
                        loading={actionLoading === block.uid}
                        onClick={() => doAction(block.uid, 'retract')}
                      />
                    )}
                    <Button
                      color="blue"
                      icon="sync"
                      content="Update"
                      loading={actionLoading === block.uid}
                      onClick={() => openUpdateModal(block)}
                    />
                    {block.active ? (
                      <Button
                        icon="pause"
                        content="Deactivate"
                        loading={actionLoading === block.uid}
                        onClick={() => doAction(block.uid, 'deactivate')}
                      />
                    ) : (
                      <Button
                        icon="play"
                        content="Activate"
                        loading={actionLoading === block.uid}
                        onClick={() => doAction(block.uid, 'activate')}
                      />
                    )}
                    <Button
                      negative
                      icon="trash"
                      loading={actionLoading === block.uid}
                      onClick={() => setConfirmDelete(block.uid)}
                    />
                  </Button.Group>
                  <Confirm
                    open={confirmDelete === block.uid}
                    header="Delete Block"
                    content={`Are you sure you want to delete "${block.title}"? This action cannot be undone.`}
                    confirmButton="Delete"
                    cancelButton="Cancel"
                    onCancel={() => setConfirmDelete(null)}
                    onConfirm={() => doAction(block.uid, 'delete')}
                  />
                </Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table>

        <div style={{ marginTop: '1em', color: '#888', fontSize: '0.9em' }}>
          Total: {blocks.length} block(s)
        </div>
      </Segment>

      {/* Install Modal */}
      <Modal
        open={showInstall}
        onClose={() => { setShowInstall(false); resetForm(); }}
        size="small"
        closeIcon
      >
        <Modal.Header>Install New MF Block</Modal.Header>
        <Modal.Content>
          <Form>
            {detectNote && (
              <Message info={!detectWarn} warning={detectWarn} size="small">
                {detectNote}
              </Message>
            )}
            <Form.Input
              label="Block Name"
              placeholder="e.g. Hero Banner"
              value={formData.title}
              onChange={(_, { value }) => handleTitleChange(value as string)}
              required
            />

            <Form.Group widths="equal">
              <Form.Input
                label="Block ID"
                placeholder="hero-banner"
                value={formData.block_id}
                onChange={(_, { value }) =>
                  setFormData((prev) => ({ ...prev, block_id: value as string }))
                }
                required
              />
              <Form.Input
                label="Version"
                placeholder="1.0.0"
                value={formData.version}
                onChange={(_, { value }) =>
                  setFormData((prev) => ({ ...prev, version: value as string }))
                }
              />
            </Form.Group>

            <Form.Group widths="equal">
              <Form.Input
                label={autoFields.remote_name ? 'Remote Name (del bundle)' : 'Remote Name'}
                placeholder="voltoHeroBannerBlock"
                value={formData.remote_name}
                readOnly={!!autoFields.remote_name}
                onChange={(_, { value }) =>
                  setFormData((prev) => ({ ...prev, remote_name: value as string }))
                }
                required
              />
              <Form.Input
                label={autoFields.remote_module ? 'Remote Module (del bundle)' : 'Remote Module'}
                placeholder="./block"
                value={formData.remote_module}
                readOnly={!!autoFields.remote_module}
                onChange={(_, { value }) =>
                  setFormData((prev) => ({ ...prev, remote_module: value as string }))
                }
              />
            </Form.Group>

            <Form.Select
              label="Group"
              options={groupOptions}
              value={formData.group}
              onChange={(_, { value }) =>
                setFormData((prev) => ({ ...prev, group: value as string }))
              }
            />

            <Divider />

            <Form.Field required>
              <label>Bundle (.tar.gz)</label>
              <input
                ref={fileInputRef}
                type="file"
                accept=".tar.gz,.tgz"
                onChange={(e) => {
                  handleBundleSelect(e.target.files?.[0] || null);
                }}
              />
              {bundleFile && (
                <small style={{ color: '#888' }}>
                  {bundleFile.name} ({(bundleFile.size / 1024).toFixed(1)} KB)
                </small>
              )}
            </Form.Field>
          </Form>
        </Modal.Content>
        <Modal.Actions>
          <Button onClick={() => { setShowInstall(false); resetForm(); }}>
            Cancel
          </Button>
          <Button
            primary
            icon="upload"
            content="Install & Publish"
            loading={installing}
            onClick={handleInstall}
          />
        </Modal.Actions>
      </Modal>

      {/* Update Modal */}
      <Modal
        open={!!updateTarget}
        onClose={closeUpdateModal}
        size="small"
        closeIcon
      >
        <Modal.Header>Update Block: {updateTarget?.title}</Modal.Header>
        <Modal.Content>
          <Form>
            <Message info>
              <p>
                Upload a new bundle to replace the current one.
                The block configuration (ID, name, group) will remain unchanged.
              </p>
            </Message>

            <Form.Input
              label="New Version"
              placeholder={updateTarget?.version || '1.0.0'}
              value={updateVersion}
              onChange={(_, { value }) => setUpdateVersion(value as string)}
            />

            <Form.Field required>
              <label>New Bundle (.tar.gz)</label>
              <input
                ref={updateFileRef}
                type="file"
                accept=".tar.gz,.tgz"
                onChange={(e) => {
                  const file = e.target.files?.[0] || null;
                  setUpdateFile(file);
                }}
              />
              {updateFile && (
                <small style={{ color: '#888' }}>
                  {updateFile.name} ({(updateFile.size / 1024).toFixed(1)} KB)
                </small>
              )}
            </Form.Field>
          </Form>
        </Modal.Content>
        <Modal.Actions>
          <Button onClick={closeUpdateModal}>
            Cancel
          </Button>
          <Button
            primary
            icon="sync"
            content="Update Block"
            loading={updating}
            disabled={!updateFile}
            onClick={handleUpdate}
          />
        </Modal.Actions>
      </Modal>
      {isClient && createPortal(
        <Toolbar pathname={pathname} hideDefaultViewButtons
          inner={
            <Link to="/controlpanel" className="item">
              <VIcon name={backSVG} aria-label={intl.formatMessage(messages.back)}
                className="contents circled" size="30px"
                title={intl.formatMessage(messages.back)} />
            </Link>
          }
        />,
        document.getElementById('toolbar'),
      )}
    </Container>
  );
};

export default MFBlocksControlPanel;
