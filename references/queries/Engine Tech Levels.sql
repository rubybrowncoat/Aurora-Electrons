SELECT
	dc.Name
	,dc.ComponentValue
FROM
	FCT_ShipDesignComponents as dc
WHERE
	dc.ComponentTypeID = 11
order by dc.ComponentValue