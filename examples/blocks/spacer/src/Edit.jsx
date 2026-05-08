import React from 'react';

/**
 * SpacerEdit — Solo renderiza el preview del bloque.
 * El sidebar con las propiedades lo maneja Volto automáticamente
 * usando el schema exportado desde index.js.
 */
const SpacerEdit = (props) => {
  const { data } = props;
  const height = Math.max(0, Math.min(Number(data?.height) || 100, 2000));

  return (
    <div
      style={{
        height: `${height}px`,
        background: '#f0f4f8',
        border: '1px dashed #999',
        borderRadius: '4px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: '#666',
        fontSize: '0.85rem',
      }}
    >
      Spacer — {height}px
    </div>
  );
};

export default SpacerEdit;
