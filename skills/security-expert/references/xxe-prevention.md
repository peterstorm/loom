# XXE (XML External Entity) Prevention Reference

## The Attack

The XML parser resolves entities declared in the document's DTD. An attacker uses that to read files, reach internal services, or exhaust memory.

```xml
<?xml version="1.0"?>
<!DOCTYPE foo [
  <!ENTITY xxe SYSTEM "file:///etc/passwd">
]>
<userInfo><name>&xxe;</name></userInfo>
```

| Variant | Declaration |
|---------|-------------|
| File read | `<!ENTITY xxe SYSTEM "file:///etc/passwd">` |
| SSRF | `<!ENTITY xxe SYSTEM "http://internal-service/admin">` |
| Billion laughs (DoS) | Nested entities that expand exponentially |
| Blind / out-of-band | A parameter entity loads an external DTD that sends data to the attacker |

## Where XML Is Parsed

SOAP services, XML uploads and imports, RSS/Atom feeds, SVG, Office documents (OOXML is a zip of XML), SAML responses, XSLT, configuration files.

## Prevention

Java's XML parsers resolve DTDs and external entities unless told otherwise. Configure every factory you create. The simplest rule: if you do not need DTDs, disallow the DOCTYPE declaration entirely.

### SAXParserFactory
```java
SAXParserFactory factory = SAXParserFactory.newInstance();
factory.setFeature("http://apache.org/xml/features/disallow-doctype-decl", true);
factory.setFeature("http://xml.org/sax/features/external-general-entities", false);
factory.setFeature("http://xml.org/sax/features/external-parameter-entities", false);
```
The same three features apply to an `XMLReader` (`reader.setFeature(...)`).

### DocumentBuilderFactory
```java
DocumentBuilderFactory factory = DocumentBuilderFactory.newInstance();
factory.setFeature("http://apache.org/xml/features/disallow-doctype-decl", true);
factory.setFeature("http://xml.org/sax/features/external-general-entities", false);
factory.setFeature("http://xml.org/sax/features/external-parameter-entities", false);
factory.setXIncludeAware(false);
factory.setExpandEntityReferences(false);
```

### XMLInputFactory (StAX)
```java
XMLInputFactory factory = XMLInputFactory.newInstance();
factory.setProperty(XMLInputFactory.SUPPORT_DTD, false);
factory.setProperty(XMLInputFactory.IS_SUPPORTING_EXTERNAL_ENTITIES, false);
```

### TransformerFactory (XSLT)
```java
TransformerFactory factory = TransformerFactory.newInstance();
factory.setFeature(XMLConstants.FEATURE_SECURE_PROCESSING, true);
factory.setAttribute(XMLConstants.ACCESS_EXTERNAL_DTD, "");
factory.setAttribute(XMLConstants.ACCESS_EXTERNAL_STYLESHEET, "");
```

### SchemaFactory and Validator
```java
SchemaFactory factory = SchemaFactory.newInstance(XMLConstants.W3C_XML_SCHEMA_NS_URI);
factory.setProperty(XMLConstants.ACCESS_EXTERNAL_DTD, "");
factory.setProperty(XMLConstants.ACCESS_EXTERNAL_SCHEMA, "");

Validator validator = factory.newSchema(schemaSource).newValidator();
validator.setProperty(XMLConstants.ACCESS_EXTERNAL_DTD, "");
validator.setProperty(XMLConstants.ACCESS_EXTERNAL_SCHEMA, "");
```

### JAXB
JAXB parses with whatever source it is given. Hand it a reader from a hardened factory.
```java
SAXParserFactory spf = SAXParserFactory.newInstance();
spf.setNamespaceAware(true);
spf.setFeature("http://apache.org/xml/features/disallow-doctype-decl", true);
spf.setFeature("http://xml.org/sax/features/external-general-entities", false);
spf.setFeature("http://xml.org/sax/features/external-parameter-entities", false);

Source source = new SAXSource(spf.newSAXParser().getXMLReader(), new InputSource(inputStream));
MyClass obj = (MyClass) JAXBContext.newInstance(MyClass.class).createUnmarshaller().unmarshal(source);
```

### dom4j and JDOM
```java
// dom4j
SAXReader reader = new SAXReader();
reader.setFeature("http://apache.org/xml/features/disallow-doctype-decl", true);
reader.setFeature("http://xml.org/sax/features/external-general-entities", false);
reader.setFeature("http://xml.org/sax/features/external-parameter-entities", false);

// JDOM 2
SAXBuilder builder = new SAXBuilder();
builder.setFeature("http://apache.org/xml/features/disallow-doctype-decl", true);
builder.setExpandEntities(false);
```

### Spring
- Spring MVC's own XML message converters (JAXB, Jackson XML) are created with DTD support and external entities off. The risk is XML you parse yourself, and libraries you hand a stream to (document parsers, SAML and SOAP stacks): check each one's parser configuration and keep them patched.
- If the application has no XML endpoints, do not put an XML data-format library on the classpath, so no XML converter is registered.
- Uploaded Office documents and SVG are XML: see `file-upload-security.md`.

## Testing
```java
@Test
void rejectsDoctype() throws Exception {
    String payload = """
        <?xml version="1.0"?>
        <!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>
        <input><value>&xxe;</value></input>
        """;

    mockMvc.perform(post("/api/import")
            .contentType(MediaType.APPLICATION_XML)
            .content(payload))
        .andExpect(status().isBadRequest());
}
```
For parsers used outside a controller, feed the same document to the configured factory and assert that parsing throws.

## Quick Reference

| Parser | Disable DTD | Disable external access |
|--------|-------------|-------------------------|
| SAXParserFactory, XMLReader, dom4j `SAXReader` | `disallow-doctype-decl = true` | `external-general-entities`, `external-parameter-entities = false` |
| DocumentBuilderFactory | `disallow-doctype-decl = true` | Same, plus `setXIncludeAware(false)`, `setExpandEntityReferences(false)` |
| XMLInputFactory | `SUPPORT_DTD = false` | `IS_SUPPORTING_EXTERNAL_ENTITIES = false` |
| TransformerFactory | `ACCESS_EXTERNAL_DTD = ""` | `ACCESS_EXTERNAL_STYLESHEET = ""` |
| SchemaFactory, Validator | `ACCESS_EXTERNAL_DTD = ""` | `ACCESS_EXTERNAL_SCHEMA = ""` |
| JDOM `SAXBuilder` | `disallow-doctype-decl = true` | `setExpandEntities(false)` |
| JAXB | Configure the underlying SAX source | Same as SAX |

**Simplest rule: if you don't need DTDs, disable them entirely with `disallow-doctype-decl`.**
