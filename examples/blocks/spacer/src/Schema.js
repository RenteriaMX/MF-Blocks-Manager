const SpacerSchema = {
  title: 'Spacer',
  fieldsets: [
    {
      id: 'default',
      title: 'Spacer',
      fields: ['height', 'debugAuth'],
    },
  ],
  properties: {
    height: {
      title: 'Altura (px)',
      description: 'Espacio en píxeles entre bloques',
      type: 'integer',
      default: 100,
      minimum: 0,
      maximum: 2000,
    },
    debugAuth: {
      title: 'Mostrar estado de auth (demo)',
      description:
        'Si se activa, el bloque muestra "auth"/"anon" según reciba props.authToken del host. Solo para demostrar el paso del token.',
      type: 'boolean',
      default: false,
    },
  },
  required: [],
};

export default SpacerSchema;
