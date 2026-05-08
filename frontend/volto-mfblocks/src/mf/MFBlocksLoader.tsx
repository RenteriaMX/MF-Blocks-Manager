/**
 * Wrapper components para bloques MF.
 *
 * Regla de Oro: El bloque remoto SOLO exporta React puro + schema.
 * El sidebar (SidebarPortal + BlockDataForm) se maneja AQUÍ en el host.
 *
 * Soporte para bloques contenedor (container: true):
 * El host renderiza BlocksForm dentro de cada columna/zona del bloque.
 */

import React, { useEffect, useState } from 'react';
import { SidebarPortal } from '@plone/volto/components';
import BlockDataForm from '@plone/volto/components/manage/Form/BlockDataForm';
import { BlocksForm } from '@plone/volto/components/manage/Form';
import { blocksFormGenerator } from '@plone/volto/helpers/Blocks/Blocks';
import { loadRemoteModule } from './loader';
import config from '@plone/volto/registry';
import RenderBlocks from '@plone/volto/components/theme/View/RenderBlocks';
import DefaultEditBlockWrapper from '@plone/volto/components/manage/Blocks/Container/EditBlockWrapper';

/**
 * Componente que renderiza una zona de bloques dentro de una columna.
 * Usa BlocksForm + EditBlockWrapper nativo de Volto para soporte completo:
 * - Boton X para borrar/resetear sub-bloques
 * - "Add a new block" con chooser cuando el bloque esta vacio
 * - Drag & drop de sub-bloques
 */
const ColumnBlocksZone = ({
  columnIndex,
  data,
  block,
  onChangeBlock,
  onChangeField,
  pathname,
  metadata,
  properties,
  selected,
  manage,
}: any) => {
  const columnKey = `column_${columnIndex}`;
  const columnData = data?.[columnKey] || {};

  // Inicializar con 0 bloques — el EditBlockWrapper mostrara "Add a new block"
  const isInitialized = columnData?.blocks && columnData?.blocks_layout;

  const [initialData] = useState(() => blocksFormGenerator(1, 'empty'));
  const zoneProperties = isInitialized ? columnData : initialData;

  // Persistir datos iniciales si no estan inicializados
  useEffect(() => {
    if (!isInitialized && onChangeBlock) {
      onChangeBlock(block, {
        ...data,
        [columnKey]: initialData,
      });
    }
  }, []);  // eslint-disable-line react-hooks/exhaustive-deps

  const [selectedBlock, setSelectedBlock] = useState<string | null>(
    zoneProperties.blocks_layout?.items?.[0] || null,
  );

  const blockState: any = {};

  return (
    <div className="mf-column-blocks-zone">
      <BlocksForm
        metadata={metadata || properties}
        properties={zoneProperties}
        manage={manage || false}
        selectedBlock={selected ? selectedBlock : null}
        blocksConfig={config.blocks.blocksConfig}
        isContainer
        isMainForm={false}
        stopPropagation={selectedBlock}
        disableAddBlockOnEnterKey={false}
        direction="vertical"
        onSelectBlock={(id: string) => {
          setSelectedBlock(id);
        }}
        onChangeFormData={(newFormData: any) => {
          onChangeBlock(block, {
            ...data,
            [columnKey]: {
              ...columnData,
              ...newFormData,
            },
          });
        }}
        onChangeField={(id: string, value: any) => {
          if (['blocks', 'blocks_layout'].includes(id)) {
            blockState[id] = value;
            onChangeBlock(block, {
              ...data,
              [columnKey]: {
                ...columnData,
                ...blockState,
              },
            });
          } else if (onChangeField) {
            onChangeField(id, value);
          }
        }}
        pathname={pathname}
      >
        {({ draginfo }: any, editBlock: any, blockProps: any) => (
          <DefaultEditBlockWrapper draginfo={draginfo} blockProps={blockProps}>
            {editBlock}
          </DefaultEditBlockWrapper>
        )}
      </BlocksForm>
    </div>
  );
};

/**
 * Componente View para renderizar bloques hijos de una columna.
 */
const ColumnBlocksView = ({ columnData, path }: any) => {
  if (!columnData?.blocks || !columnData?.blocks_layout) {
    return null;
  }

  return (
    <RenderBlocks
      content={columnData}
      path={path}
    />
  );
};

/**
 * Crea los componentes View y Edit para un bloque MF.
 */
export function createMFBlockComponents(
  remoteName: string,
  remoteUrl: string,
  remoteModule: string = './block',
) {
  const View = (props: any) => {
    const [Component, setComponent] = useState<React.ComponentType<any> | null>(null);
    const [blockDef, setBlockDef] = useState<any>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
      loadRemoteModule(remoteName, remoteUrl, remoteModule)
        .then((mod) => {
          const def = mod.default || mod;
          setBlockDef(def);
          if (def.view) setComponent(() => def.view);
          else setError('No view component');
        })
        .catch((err) => setError(err.message));
    }, []);

    if (error) return <div style={{ color: 'red' }}>[MF] {error}</div>;
    if (!Component) return null;

    // Si es contenedor, pasar renderColumnBlocks al View
    if (blockDef?.container) {
      const renderColumnBlocks = (columnIndex: number) => (
        <ColumnBlocksView
          columnData={props.data?.[`column_${columnIndex}`]}
          path={props.path}
        />
      );
      return <Component {...props} renderColumnBlocks={renderColumnBlocks} />;
    }

    return <Component {...props} />;
  };

  const Edit = (props: any) => {
    const [Component, setComponent] = useState<React.ComponentType<any> | null>(null);
    const [schema, setSchema] = useState<any>(null);
    const [isContainer, setIsContainer] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const { data, onChangeBlock, onChangeField, block, selected, pathname, manage } = props;

    useEffect(() => {
      loadRemoteModule(remoteName, remoteUrl, remoteModule)
        .then((mod) => {
          const blockDef = mod.default || mod;
          if (blockDef.edit) setComponent(() => blockDef.edit);
          if (blockDef.schema) setSchema(blockDef.schema);
          if (blockDef.container) setIsContainer(true);
        })
        .catch((err) => {
          console.error('[MF Edit] Error:', err);
          setError(err.message);
        });
    }, []);

    if (error) return <div style={{ color: 'red' }}>[MF] {error}</div>;
    if (!Component) return <div style={{ opacity: 0.5 }}>Loading...</div>;

    // Si es contenedor, pasar renderColumnBlocks al Edit
    const renderColumnBlocks = isContainer
      ? (columnIndex: number) => (
          <ColumnBlocksZone
            columnIndex={columnIndex}
            data={data}
            block={block}
            onChangeBlock={onChangeBlock}
            onChangeField={onChangeField}
            pathname={pathname}
            metadata={props.metadata}
            properties={props.properties}
            selected={selected}
            manage={manage}
          />
        )
      : undefined;

    return (
      <>
        <Component
          {...props}
          renderColumnBlocks={renderColumnBlocks}
        />
        {schema && (
          <SidebarPortal selected={selected}>
            <BlockDataForm
              schema={schema}
              title={schema.title || 'Block'}
              onChangeField={(id: string, value: any) => {
                onChangeBlock(block, { ...data, [id]: value });
              }}
              onChangeBlock={onChangeBlock}
              formData={data}
              block={block}
              pathname={pathname}
            />
          </SidebarPortal>
        )}
      </>
    );
  };

  return { View, Edit };
}

export default createMFBlockComponents;
